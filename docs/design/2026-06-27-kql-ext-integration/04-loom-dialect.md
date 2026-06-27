# 04 · loom 方言（逻辑视图）

新增的第四个 kql 方言，与 pg/sqlite/duckdb 并列。**不执行**——它是逻辑视图，把 entity 当扁平表，不展开 JOIN/JSONB/sourceHash。

---

## 1. 定位

| 维度 | 说明 |
|---|---|
| **不执行** | 假设存在扁平 `Product` 表，但物理上没有。生产执行走 pg/sqlite |
| **逻辑形态** | 所有列（base + ext）扁平出现，无 JOIN，无 JSONB 提取 |
| **方言无关类型** | 用 KQL 类型（`long`/`string`/`real`），不翻译成 DB 方言类型 |
| **隐藏物理细节** | sourceHash、JSON key、sidecar 表名一律不出现 |

## 2. 用途

### 2.1 可读性 / explain

```
kql explain --dialect loom 'Product | where sku == "X" | take 10'
```

输出：
```sql
SELECT u.id, u.name, u.sku, u.stock_qty
FROM Product u
WHERE u.sku = ?1
LIMIT 10
```

人能直接读懂查询意图，无需理解 ext 物理细节。

### 2.2 跨方言等价性验证

loom 方言与 pg/sqlite 方言应语义等价。测试基线：同一 KQL 在 loom + pg 两个方言下，列名、类型、谓词结构一一对应，可程序化对照。

```
test: 同一 KQL → {loom SQL, pg SQL}
assert: 列名集合相等
assert: 谓词的列引用集合相等
assert: LIMIT/ORDER BY 结构相等
```

### 2.3 多租户审计

记录「这个 tenant 当时能看到的查询逻辑形态」+ 当时 context 的 owner 列表：

```
audit log:
  tenant: 42
  owners: [platform, ext:provider-a, tenant:42]
  kql:    Product | where sku == "X" | take 10
  loom SQL: SELECT u.id, u.name, u.sku, u.stock_qty FROM Product u WHERE u.sku = ?1 LIMIT 10
  pg SQL:   SELECT u.id, u.name, (se0.values->>'sku')::text AS sku, ...
```

事后可回溯「这个查询在当时为什么看到这些列」——loom SQL 暴露了 tenant 视角，pg SQL 暴露了物理执行。

### 2.4 loom 反向消费（future）

loom 自身或下游工具消费「逻辑 SQL」做下一步投影：
- 投到非 SQL 后端（如 GraphQL、文档数据库）
- 生成查询文档（用户视角的 API 文档）
- 跨租户查询联邦（统一逻辑形态后路由）

本期不实现反向消费链路，仅保证 loom 方言 SQL 可被解析。

## 3. 文法规则

| 元素 | 形态 | 说明 |
|---|---|---|
| 表名 | `<EntityName>` 或 `<system>.<module>.<EntityName>` | entity 名，非物理表名 |
| 列名 | `<alias>.<col>` | 所有列扁平，alias 通常 `u` |
| 占位符 | `?N` | 与 sqlite 一致，编号占位 |
| 类型 | KQL 类型（`long`/`string`/`real`/`bool`/`dynamic`） | 不翻译成 DB 方言类型 |
| JOIN | **不生成** | 核心差异 |
| sourceHash / JSON key | **不出现** | 完全隐藏 |
| WHERE | `u.<col> <op> ?N` | 与其他方言同结构 |
| GROUP BY | `<expr>` 或 `<alias>` | 用别名（loom 方言下安全） |
| ORDER BY | 同上 | |
| LIMIT / OFFSET | 数字 | |

## 4. 与 pg/sqlite 的对照

同一 KQL：`Product | where sku == 'X' | project name, stock_qty | take 10`

### loom 方言
```sql
SELECT u.name, u.stock_qty
FROM Product u
WHERE u.sku = ?1
LIMIT 10
```

### pg 方言（对照）
```sql
SELECT u.name,
       (se0.values->>'stock_qty')::bigint AS stock_qty
FROM shop_core.products_base u
LEFT JOIN products_ext se0
  ON se0.base_id_0 = u.id
  AND se0.source = 'a1b2c3d4e5f67890'
  AND (se0.values->>'sku')::text = $1
LIMIT 10
```

### 等价性验证点
- 列名集合：loom `{name, stock_qty}` == pg `{name, stock_qty AS}` ✓
- 谓词列引用：loom `sku` ↔ pg `(se0.values->>'sku')::text` ✓
- LIMIT：10 == 10 ✓

## 5. 多 owner 体现

context 过滤后只剩 `ext:provider-a`：

```sql
-- tenant:42 context, owners=[platform, ext:provider-a]
SELECT u.name, u.sku, u.stock_qty
FROM Product u
WHERE u.sku = ?1
-- "Product" 这个名字此刻只暴露这些列
```

同一 KQL 在 tenant:99 context（只装 platform）：
```
binder: KQL001 unknown column 'sku'
```

**审计价值**：保存 loom SQL + 当时 owner 列表 = 完整回溯「为什么看到这些列」。

## 6. 实现位置

```
internal/backend/loom/
├── backend.go      // Backend 接口实现: Dialect()="loom"
├── emit.go         // Emit(): 调用通用 emit, 但 Origin 处理走逻辑分支
└── backend_test.go
```

`Backend.Emit()` 复用通用 emit 框架（[03-join-injection-and-emit.md](03-join-injection-and-emit.md) §2.3），只在 `dialectExtractSidecar` 处走逻辑分支：

```go
func (b *Backend) dialectExtractSidecar(baseAlias string, o SidecarJSONKey, _ ir.Type) string {
    return fmt.Sprintf("%s.%s", baseAlias, o.JSONKey)
}
```

且 `Backend.Emit()` 跳过 JoinPlan 生成（不需要 JOIN），直接以 entity 为单一表名 emit。

## 7. Backend 接口适配

`backend.Backend`（`internal/backend/backend.go:62`）要求：

```go
type Backend interface {
    Dialect() Dialect
    Emit(pipe *ir.Pipeline) (*Query, error)
    Exec(ctx context.Context, q *Query) (*Result, error)
    Close() error
}
```

loom 方言：
- `Dialect()` → `"loom"`
- `Emit()` → 正常生成逻辑 SQL
- `Exec()` → **返回错误**：`"loom dialect is non-executable; use for explain/audit only"`
- `Close()` → no-op

`pkg/kql.Exec()` 在检测到 dialect=loom 且非 explain 路径时，提前拒绝并提示用户切换方言。

## 8. CLI 集成

```
kql explain --dialect loom --loom-schema ./out/ 'KQL...'
kql explain --dialect pg     --loom-schema ./out/ 'KQL...'   # 对照
kql run     --dialect pg     --loom-schema ./out/ 'KQL...'   # 实际执行
```

`--dialect` 默认从 DSN 推断（pg/sqlite/duckdb），显式传 `loom` 仅对 explain/validate 有意义。

## 9. 局限（明确不做）

- **不能直接执行**：物理上没有扁平 entity 表（除非 loom 真物化 view，那就回到旧方案 A 了）
- **不支持 JSONB 专有优化**：GIN 索引提示、`@>` 操作符、jsonb_path_ops 等 pg 专有能力，loom 方言表达不了
- **不暴露 sourceHash**：无法在 loom 方言层面做按 source 过滤的优化
- **不表达物理 JOIN 顺序**：cost-based join order 是物理层的事

**结论**：loom 方言是**解释层**，不是**执行层**。生产执行走 pg/sqlite 方言；loom 方言留给工具链、文档、测试、审计。

## 10. 未来扩展

- **loom 方言作为 IR 文本表示**：未来可把 loom SQL 当作 kql IR 的可序列化文本格式（类似 relational algebra 的字符串形式），用于跨进程传递查询意图
- **双向转换**：loom SQL → KQL 反向解析（让 loom 方言 SQL 可作为 KQL 的另一种输入语法）。本期不做
