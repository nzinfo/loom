# 02 · kql LoomCatalog 与列绑定

kql 侧的核心数据结构与 schema provider 实现。负责把 `loom-schema.json` 加载成内存模型，按 context 过滤，并实现 `binder.SchemaProvider` 让现有 bind 流程透明地看到扩展字段。

---

## 1. 包结构

新增 kql 包（建议路径，最终以实现为准）：

```
internal/loomcatalog/
├── catalog.go          // LoomCatalog: 加载/查询/过滤
├── origin.go           // ColumnOrigin 类型定义
├── context.go          // Context (owners 白名单)
├── loader.go           // JSON → LoomCatalog
├── cache.go            // LRU 缓存 (按 sourceHash)
└── catalog_test.go
```

`pkg/kql` 加 `--loom-schema` / `--loom-owners` 选项，把 `LoomCatalog` 接进 `ExecOnOpt`。

## 2. ColumnOrigin —— 列出身的元数据

核心扩展点。`binder.ColBinding`（`internal/frontend/binder/binder.go:31`）现有字段：

```go
type ColBinding struct {
    ColID        ir.ColID
    PhysicalName string
    DisplayName  string
    Type         ir.Type
}
```

**新增一个字段**（不改前 4 个，向后兼容）：

```go
type ColBinding struct {
    ColID        ir.ColID
    PhysicalName string
    DisplayName  string
    Type         ir.Type
    Origin       ColumnOrigin  // ★ 新增; nil 表示普通 base 列
}

// ColumnOrigin 描述一列的物理来源, 决定 emit 时的取值表达式
type ColumnOrigin interface{ isColumnOrigin() }

// PhysicalColumn: base 表或 new_table ext 表的真实列
type PhysicalColumn struct {
    Table  string  // 物理表名 (含 schema 前缀)
    Column string  // 物理列名
}
func (PhysicalColumn) isColumnOrigin() {}

// SidecarJSONKey: sidecar_jsonb 策略下, JSONB values 文档里的一个 key
type SidecarJSONKey struct {
    SidecarTable string   // 物理表名
    JSONKey      string   // JSON 文档里的 key
    SourceHash   string   // AND source = '<hash>' 用
    BaseJoinCols []string // base 端 join 列 (复合 PK 时多个)
    ExtJoinCols  []string // ext 端 join 列 (base_id_0..N)
}
func (SidecarJSONKey) isColumnOrigin() {}
```

**为什么是接口而非 union**：未来若加新策略（如 columnar_jsonb），加一个实现即可，不破坏现有调用点。

## 3. LoomCatalog —— schema provider 实现

### 3.1 内存模型

```go
type LoomCatalog struct {
    entities   map[string]*EntityDef      // entity 名 (PascalCase 或 identity)
    sidecars   map[string]*SidecarMeta    // sidecar 表名 → join 元数据
    newTables  map[string]*NewTableMeta
    scalars    map[string]*ScalarMap      // scalar → 方言类型
    sourceHash string                     // 顶层校验值, LRU 缓存键
}

type EntityDef struct {
    Identity        string
    BaseTable       *PhysicalTableDef
    ExtensionFields []*ExtFieldDef
}

type ExtFieldDef struct {
    Name       string
    Scalar     string
    Props      map[string]any
    Group      string
    Owner      string  // "platform" | "ext:provider-a" | "tenant:42"
    Strategy   string  // "sidecar_jsonb" | "new_table"
    TableName  string
    SourceHash string  // sidecar only
    JSONKey    string  // sidecar only
}

type SidecarMeta struct {
    BaseTableIdentity string
    BaseJoinColumns   []string
    ExtJoinColumns    []string
}
```

### 3.2 SchemaProvider 实现

```go
// Schema 实现 binder.SchemaProvider (binder.go:72)
//
// 返回 entity 的完整列视图: base 列 + 当前可见 ext 列.
// 多租户过滤已在 ForContext() 期完成, 这里零分支.
func (c *LoomCatalog) Schema(name string) (*binder.Schema, error) {
    ent, ok := c.entities[normalize(name)]
    if !ok {
        return nil, nil  // nil schema = permissive (binder.go:48), 不影响其他 provider
    }

    cols := make([]binder.ColBinding, 0, len(ent.BaseTable.Columns)+len(ent.ExtensionFields))

    // base 列: PhysicalColumn origin
    for _, col := range ent.BaseTable.Columns {
        cols = append(cols, binder.ColBinding{
            PhysicalName: col.Name,
            DisplayName:  col.Name,
            Type:         mapScalarToIR(col.Scalar),
            Origin: PhysicalColumn{
                Table:  ent.BaseTable.QualifiedName,
                Column: col.Name,
            },
        })
    }

    // ext 列: 按 strategy 区分 origin 类型
    for _, ef := range ent.ExtensionFields {
        switch ef.Strategy {
        case "sidecar_jsonb":
            sm := c.sidecars[ef.TableName]
            cols = append(cols, binder.ColBinding{
                PhysicalName: ef.Name,    // KQL 用户看到的名字
                DisplayName:  ef.Name,
                Type:         mapScalarToIR(ef.Scalar),
                Origin: SidecarJSONKey{
                    SidecarTable: ef.TableName,
                    JSONKey:      ef.JSONKey,
                    SourceHash:   ef.SourceHash,
                    BaseJoinCols: sm.BaseJoinColumns,
                    ExtJoinCols:  sm.ExtJoinColumns,
                },
            })
        case "new_table":
            cols = append(cols, binder.ColBinding{
                PhysicalName: ef.Name,
                DisplayName:  ef.Name,
                Type:         mapScalarToIR(ef.Scalar),
                Origin: PhysicalColumn{
                    Table:  ef.TableName,  // new_table 的物理表
                    Column: ef.Name,
                },
            })
        }
    }

    return &binder.Schema{Cols: cols}, nil
}
```

### 3.3 关键不变量

- `Schema()` 永远不返回 error（除非 catalog 损坏）；entity 不存在时返回 `nil`，让 binder 走 permissive 路径或交给下一个 provider
- base 列与 ext 列**对 binder 完全等价**：都是 `ColBinding`，只有 `Origin` 不同
- `Origin` 字段是 emit 阶段消费的，binder/optimizer 完全不读它

## 4. 多租户 / 多 owner 过滤

### 4.1 Context 模型

```go
type Context struct {
    Owners []string  // 白名单, 如 ["platform", "ext:provider-a", "tenant:42"]
}

// ParseOwners 解析 --loom-owners 字符串
//   "platform,ext:provider-a,tenant:42" → Context{...}
```

### 4.2 过滤算法

```go
// ForContext 返回一个只含白名单 owner 的 ext 字段的子集 catalog.
// ★ 在 catalog 加载后立即执行一次, 查询期零开销.
func (c *LoomCatalog) ForContext(ctx Context) *LoomCatalog {
    out := &LoomCatalog{
        sidecars:   c.sidecars,    // 共享, 不可变
        newTables:  c.newTables,
        scalars:    c.scalars,
        sourceHash: c.sourceHash + "|ctx:" + hashOwners(ctx.Owners),
        entities:   make(map[string]*EntityDef, len(c.entities)),
    }
    ownerSet := toSet(ctx.Owners)

    for name, ent := range c.entities {
        filtered := filterInPlace(ent.ExtensionFields, func(ef *ExtFieldDef) bool {
            return ownerSet[ef.Owner]
        })
        out.entities[name] = &EntityDef{
            Identity:        ent.Identity,
            BaseTable:       ent.BaseTable,
            ExtensionFields: filtered,
        }
    }
    return out
}
```

### 4.3 隔离保证

- **不可见列直接 KQL001**：tenant:42 的 catalog 里没有 `tenant:99` 的 ext 字段，binder 找不到列 → `KQL001 unknown column 'xxx'`
- **共享 sidecar 表不泄露**：即使物理上同表，不同 sourceHash 的字段在不同 tenant 看到不同子集
- **过滤一次，查询 N 次**：`ForContext()` 是 O(字段数) 一次性操作，后续查询零分支

### 4.4 默认 context

未传 `--loom-owners` 时，默认包含 `platform` + 所有 `ext:*`，不含 `tenant:*`。理由：tenant 字段是隐私数据，需要显式声明。

## 5. 与现有 SchemaProvider 的组合

kql 现有三个 backend 各自实现 `SchemaProvider`（从 DB 自省）。loom catalog 是**编译期已知的额外信息**。两者组合：

```go
// CompositeProvider: 先查 loom, miss 则 fallback 到 DB 自省
type CompositeProvider struct {
    Loom   *LoomCatalog
    Native binder.SchemaProvider  // pg/sqlite/duckdb 原生
}

func (c *CompositeProvider) Schema(name string) (*binder.Schema, error) {
    if s, _ := c.Loom.Schema(name); s != nil {
        return s, nil
    }
    return c.Native.Schema(name)
}
```

**接线位置**：`pkg/kql/kql.go` 的 `ExecOnOpt`，在 bind 前：

```
现有: backend (含 SchemaProvider) → Bind
新增: backend + LoomCatalog → CompositeProvider → Bind
```

DB 自省能力（PRAGMA / information_schema）保持不变，用于查 loom catalog 不覆盖的表（普通业务表、临时表等）。

## 6. 加载与缓存

### 6.1 加载流程

```
--loom-schema ./out/
   ├── loom-schema.json
   └── (可能多个分片, 见 §6.3)
```

1. 读 JSON → 反序列化到 `LoomCatalog`
2. `ForContext()` 过滤
3. 包成 `CompositeProvider` 接进 backend

### 6.2 LRU 缓存

```go
// 全局 LRU, key = (文件路径, sourceHash, owners 哈希)
// 命中则跳过反序列化 + ForContext, 直接返回已过滤 catalog
var catalogCache = lru.New(cacheKey, *LoomCatalog)

func LoadLoomSchema(path string, ctx Context) (*LoomCatalog, error) {
    hash, err := readSourceHash(path)             // 仅读文件头部 32 字节
    key := cacheKey{path, hash, hashOwners(ctx.Owners)}
    if cached, ok := catalogCache.Get(key); ok {
        return cached, nil                        // ★ 热路径, < 1µs
    }
    // ... 反序列化 + ForContext
}
```

详见 [05-performance-strategy.md](05-performance-strategy.md) §3。

### 6.3 大 catalog 分片（future）

单文件 > 10MB 时考虑按 entity 分片：

```
out/
├── manifest.json       // sourceHash + entity 列表 + 各分片 hash
├── shop.core.json
├── hr.core.json
└── ...
```

本期不做，单文件足够 1000 entity 用。

## 7. binder 改动评估

| 改动点 | 影响 | 风险 |
|---|---|---|
| `ColBinding` 加 `Origin` 字段 | 所有构造点（binder、各 backend schema.go） | 低：nil origin 等价于旧行为 |
| `binder.Schema` 不变 | 无 | 无 |
| `Bind`/`BindWith` 流程不变 | 无 | 无 |
| `Lookup` 大小写逻辑不变 | 无 | 无 |

**测试回归**：现有 binder_test.go 不需改（fakeProvider 构造的 ColBinding 不带 Origin，等价旧行为）。

## 8. 错误处理

| 情况 | 行为 |
|---|---|
| catalog 文件不存在 | 警告，跳过 loom provider，仅用 DB 自省 |
| catalog version 不匹配 | 错误退出，提示升级 kql |
| JSON 解析失败 | 错误退出，给出文件 + 行号 |
| entity 引用了 catalog 里不存在的 sidecar 表 | 错误退出（catalog 损坏） |
| ext 字段 scalar 未知 | 警告，按 `TypeUnknown` 处理（permissive） |

## 9. 可观测性

- `kql explain --loom-schema ./out/ --dialect loom` 应输出：
  - 当前 context 的 owner 白名单
  - 每个 entity 可见的列数（base / ext 分计）
  - 命中的 catalog cache 状态
- 详见 [04-loom-dialect.md](04-loom-dialect.md) §4
