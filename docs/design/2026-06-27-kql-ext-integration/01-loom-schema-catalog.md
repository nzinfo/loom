# 01 · loom-schema.json 交换格式

loom 投影出的扁平 catalog，是 kql 与 loom 之间的唯一契约。**方言无关**——所有 DB 方言细节由 kql 各 dialect 自己翻译。

---

## 1. 设计原则

1. **零新语义**：每个字段都能在 loom 现有 IR / PhysicalModel 里找到来源
2. **按 entity 组织**：kql 按 entity 名查 schema（"Product"），不关心 loom 的 IR graph 拓扑
3. **保留 owner 维度**：多租户过滤的原料，必须完整保留
4. **保留物理 join 元数据**：sidecar 的 base_id 映射、new_table 的 FK 列名
5. **可缓存**：含 `sourceHash` 顶层校验值，kql 据此判断是否需要重载

## 2. 完整 schema

```jsonc
{
  "version": "loom-schema/v1",
  "generatedAt": "2026-06-27T10:00:00Z",
  "sourceHash": "<xxhash64 of sorted input file contents>",
  // kql 据此判断 catalog 是否变化, 命中则跳过重解析

  // ─── 实体表: kql 查询的入口 ─────────────────────────
  "entities": {
    "shop.core.Product": {
      "identity":      "entity:shop.core.Product",
      "primaryTable":  "table:shop.core.Products",
      "businessKeys":  ["name"],
      "view":          "products",
      // view 名仅供 loom 方言/审计用; pg/sqlite emit 不依赖

      // base 表物理列 (来自 PhysicalTable, strategy='none')
      "baseTable": {
        "name":          "products_base",
        "schema":        "shop_core",
        "qualifiedName": "shop_core.products_base",
        "primaryKey":    ["id"],
        "columns": [
          { "name": "id",         "scalar": "bigint", "required": true },
          { "name": "name",       "scalar": "string",
            "props": { "max_length": 255 }, "required": true },
          { "name": "base_price", "scalar": "decimal",
            "props": { "precision": 12, "scale": 2 } }
          // struct value_type 已展开: Money → base_price_amount + base_price_currency
          // enum 列带 enumRef, kql 当 carrier scalar 处理
        ]
      },

      // 扩展字段池: 来自 IR.extensionFields[entityIdentity]
      // ★ 按 owner 过滤的原料, 必须保留全部维度
      "extensionFields": [
        {
          "name":        "sku",
          "scalar":      "string",
          "props":       { "max_length": 64 },
          "group":       "inventory",
          "owner":       "ext:provider-a",
          "strategy":    "sidecar_jsonb",
          "tableName":   "products_ext",
          "sourceHash":  "a1b2c3d4e5f67890",
          "jsonKey":     "sku"            // 默认与 name 相同; 显式以便未来改名
        },
        {
          "name":       "stock_qty",
          "scalar":     "bigint",
          "group":      "inventory",
          "owner":      "ext:provider-a",
          "strategy":   "sidecar_jsonb",
          "tableName":  "products_ext",
          "sourceHash": "a1b2c3d4e5f67890",
          "jsonKey":    "stock_qty"
        },
        {
          "name":      "warranty_months",
          "scalar":    "int",
          "group":     "warranty",
          "owner":     "ext:provider-b",
          "strategy":  "new_table",
          "tableName": "shop_core_product_warranty"
          // new_table 不需要 sourceHash/jsonKey: 字段是真实物理列
        }
      ]
    }
    // ... 更多 entity
  },

  // ─── sidecar 表 join 元数据 (复合 PK 支持) ─────────
  // 按 tableName 索引; 同一 sidecar 表被多个 entity 共享时合并
  "sidecarTables": {
    "products_ext": {
      "baseTableIdentity": "table:shop.core.Products",
      "baseJoinColumns":   ["id"],         // base 端 = base PK
      "extJoinColumns":    ["base_id_0"]   // ext 端 = base_id_0..N
      // 复合 PK: baseJoinColumns=[tenant_id, id], extJoinColumns=[base_id_0, base_id_1]
    }
  },

  // ─── new_table ext 的 FK 元数据 ────────────────────
  "newTableExts": {
    "shop_core_product_warranty": {
      "baseTableIdentity": "table:shop.core.Products",
      "baseJoinColumns":   ["id"],
      "extJoinColumns":    ["id"]          // FK 列名 = base PK 列名
    }
  },

  // ─── scalar → 方言类型映射 (可选, kql 也可内置) ───
  "scalars": {
    "bigint":  { "pg": "bigint",  "sqlite": "INTEGER", "loom": "long"   },
    "decimal": { "pg": "numeric", "sqlite": "NUMERIC",  "loom": "real"   },
    "string":  { "pg": "text",    "sqlite": "TEXT",     "loom": "string" },
    "int":     { "pg": "integer", "sqlite": "INTEGER",  "loom": "int"    }
    // 完整列表见 docs/guide/02-types.md base_types
  }
}
```

## 3. 字段映射表（loom IR → catalog）

| catalog 字段 | loom 来源 | 文件:行 |
|---|---|---|
| `entities[*].baseTable` | `PhysicalTable` (strategy='none') | `projector/types.ts:68` |
| `entities[*].baseTable.columns` | `PhysicalColumn` | `types.ts:27` |
| `entities[*].extensionFields` | `IR.extensionFields` | `ir/version.ts:142` |
| `extensionFields[*].{name,scalar,props,group,owner,strategy,tableName,sourceHash}` | `ExtensionFieldEntry` 1:1 | `ir/version.ts:102-125` |
| `extensionFields[*].jsonKey` | 默认 = `name`，未来支持改名 | (新字段) |
| `sidecarTables[*].baseJoinColumns` | `PhysicalTable.sidecarPkColumns` | `types.ts:91` |
| `sidecarTables[*].extJoinColumns` | 投影时生成的 `base_id_0..N` | design 文档 119-141 |
| `newTableExts[*]` | `PhysicalTable.foreignKeys` (strategy='new_table') | `types.ts:55` |
| `scalars` | base_types 定义 | `docs/guide/02-types.md` |

## 4. 边界情况

### 4.1 struct value_type 展开

`base_price: shop.core.Money` 在投影时展开为 `base_price_amount` + `base_price_currency` 两列。**catalog 里只出现展开后的列**，kql 不感知 struct 概念。loom 已在 `PhysicalColumn.name` 处理后缀。

### 4.2 enum 列

`PhysicalColumn.enumRef` 指向 enum 定义。catalog 里：
- 列的 `scalar` = enum 的 carrier（如 `string` / `uint8`）
- 可选附 `enumRef` 字段，供 kql 做值合法性校验（**本期不做**，留作 future）

kql 把 enum 列当普通 scalar 处理即可。

### 4.3 复合主键

base PK = `[tenant_id, id]` 时，sidecar ext 表有 `base_id_0`、`base_id_1`：

```jsonc
"sidecarTables": {
  "products_ext": {
    "baseJoinColumns": ["tenant_id", "id"],
    "extJoinColumns":  ["base_id_0", "base_id_1"]
  }
}
```

kql zip 两个数组生成 `AND` 链。

### 4.4 共享 sidecar 表

多个 entity 共享同一 sidecar 表（PK 兼容时，design 文档 152-172）。catalog 里 `sidecarTables` 按 tableName 索引，自动合并。每个 entity 的 `extensionFields` 各自引用这个 tableName + 自己的 sourceHash。

### 4.5 同表多 sourceHash

同一 `products_ext` 表，group=inventory 是 hash A，group=warranty 是 hash B。catalog 里 `extensionFields` 各自带不同 `sourceHash`。**kql 必须为不同 sourceHash 生成独立 JOIN**（见 [03-join-injection-and-emit.md](03-join-injection-and-emit.md) §2.6 边界 A）。

### 4.6 跨 owner 同名字段

loom link pass 会检测同 entity 同名跨 owner 字段并报错（`loader/link.ts:194-308`）。catalog 里**保证不出现**此情况，kql 无需处理。

## 5. 生成时机

- **推荐**：loom 投影时同时生成（新 dialect `schema` 或新 CLI 子命令 `loom project schema`）
- **可选**：独立步骤 `loom emit-catalog --out loom-schema.json`
- **热重载**：loom 监听 yaml 变化重新投影，kql 监听 catalog 文件 mtime + `sourceHash` 变化

## 6. 版本兼容

- `version: "loom-schema/v1"` 顶层字段
- 增量演进用 JSON Schema 的 `additionalProperties: true` 容忍未知字段
- 破坏性变更 bump 到 `v2`，kql 检测到不匹配版本时拒绝加载并给出明确错误

## 7. 大小预估

每 entity ~1KB（10 base 列 + 20 ext 字段）。1000 entity ≈ 1MB JSON。gzip 后 ~150KB。kql 加载 + 解析 < 50ms（含 LRU 命中检查）。详见 [05-performance-strategy.md](05-performance-strategy.md) §3。
