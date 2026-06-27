# project model JSON schema

`loom project model` 输出的 JSON 是 loom 与外部系统（ORM 生成、atlas 桥接、文档生成、
反向工程工具等）的数据接口。本文档定义其完整结构。

> 此 JSON 描述的是**物理模型**——设计层 schema 经过类型展开、字段展开后的最终物理
> 结构。不包含设计层的 `using`、短名解析等编译期概念。

## 顶层结构

```json
{
  "version": "loom-schema/v2",
  "dialect": "pg",
  "tables": [ ... ],
  "enums": [ ... ],
  "extensions": [ ... ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | 生成此模型的 loom schema 版本 |
| `dialect` | string | 投影目标方言（`pg` / `mysql` / `sqlite`）。影响标量→SQL 类型的映射 |
| `tables` | Table[] | 所有物理表（base 表）。ext 表和 view 不单独列出，由 `extensions` 描述 |
| `enums` | Enum[] | 枚举注册表 |
| `extensions` | Extension[] | 扩展字段注册表（按 entity 分组） |

## Table

```json
{
  "name": "products_base",
  "schema": "shop_core",
  "qualifiedName": "shop_core.products_base",
  "columns": [ ... ],
  "primaryKey": ["id"],
  "indexes": [ ... ],
  "foreignKeys": [ ... ],
  "extension": {
    "strategy": "sidecar_eav",
    "extTable": "products_ext",
    "view": "products"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 表名（不含 schema 前缀） |
| `schema` | string | 物理 schema 名（派生自 `<system>_<module>`，或 CLI 覆盖） |
| `qualifiedName` | string | `<schema>.<name>` |
| `columns` | Column[] | 物理列（struct 已展开） |
| `primaryKey` | string[] | 主键列名 |
| `indexes` | Index[] | 索引 |
| `foreignKeys` | ForeignKey[] | 外键约束 |
| `extension` | object? | 扩展策略信息。`strategy=none` 时省略此字段 |

### extension 对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `strategy` | string | `none` / `sidecar_eav` |
| `extTable` | string? | ext 表名（sidecar_eav 时） |
| `view` | string? | 联合视图名（来自 entity 的 `view` 声明） |

## Column

```json
{
  "name": "base_price_amount",
  "sqlType": "NUMERIC(18,4)",
  "scalar": "decimal",
  "props": { "precision": 18, "scale": 4 },
  "required": true,
  "unique": false,
  "enumRef": null
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 列名（struct 多字段已展开为 `<prefix>_<subfield>`） |
| `sqlType` | string | 目标方言的 SQL 类型（如 `VARCHAR(255)`、`NUMERIC(18,4)`、`vector(128)`） |
| `scalar` | string | loom 标量名（如 `decimal`、`string`、`uuid`） |
| `props` | object | 标量参数（precision/scale/max_length/length 等），原样透传 |
| `required` | boolean | NOT NULL |
| `unique` | boolean | UNIQUE |
| `enumRef` | string? | 如果列是枚举，指向枚举 identity（对应 `enums` 数组中的条目） |

`sqlType` 是最终的、方言特定的类型字符串——消费方不需要自己做标量→SQL 映射。

## Index

```json
{
  "name": "idx_products_name",
  "columns": ["name"],
  "unique": true
}
```

## ForeignKey

```json
{
  "name": "fk_orders_user",
  "columns": ["user_id"],
  "refTable": "users_base",
  "refColumns": ["id"],
  "onDelete": "cascade"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 约束名 |
| `columns` | string[] | 本表的外键列 |
| `refTable` | string | 引用表名 |
| `refColumns` | string[] | 引用表的列 |
| `onDelete` | string? | `cascade` / `restrict` / `set_null` / `no_action`，省略 = 无动作 |

## Enum

```json
{
  "identity": "type:shop.core.Status",
  "name": "Status",
  "carrier": "string",
  "values": ["active", "inactive", "suspended"],
  "variants": [
    { "value": "active", "display_name": "Active" },
    { "value": "inactive" },
    { "value": "suspended", "display_name": "Suspended", "description": "account is frozen" }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `identity` | string | 枚举类型的完整 identity |
| `name` | string | 枚举类型名 |
| `carrier` | string | 底层物理存储标量（`string` / `uint8` / `int16` / `integer` / `bigint`） |
| `values` | (string\|number)[] | 枚举值列表（向后兼容） |
| `variants` | object[] | variant 详情：`{ value: string\|number, display_name?, description? }`。供下游（UI label、文档、逆向工具）读取 |

Column 的 `enumRef` 通过 `identity` 关联到这里的条目。

### 结构化注释（DDL）

当 variant 携带 `display_name`/`description` 时，SQL DDL 会以**结构化注释**形式写入数据库，供逆向工具机器解析（纯字符串 variant 不生成注释）：

| 方言 | 形式 |
|---|---|
| PostgreSQL | `COMMENT ON TYPE base_core_status IS 'loom:enum active=Active\|inactive\|suspended=Suspended;account is frozen';` |
| MySQL | `status ENUM('active','inactive','suspended') COMMENT 'loom:enum active=Active\|inactive\|suspended=Suspended;account is frozen',` |
| SQLite | 列定义上方插 `-- loom:enum active=Active\|inactive\|suspended=Suspended;account is frozen` |

**注释格式契约**（稳定，逆向工具据此解析）：

```
loom:enum <value>[=<display_name>][;<description>](|<entry>)*
```

- `loom:enum` 前缀标记 loom 注入的元数据
- 每个 entry：`value`，或 `value=display_name`，或 `value=display_name;description`
- entry 用 `|` 分隔（与 SQL 值列表的 `,` 不冲突）
- variant 无 display_name/description 时该 entry 只写 `value`

> **限制**：`display_name`/`description` 不得含 `|`、`;`、`=`、换行、单引号；含这些字符时不生成结构化注释（避免破坏 DDL）。

## Extension

扩展字段按 entity 分组。每个 entity 可能有多个 group，每个 group 来自一个 owner。

```json
{
  "entity": "entity:shop.core.Product",
  "groups": [
    {
      "name": "inventory",
      "owner": "ext:provider-a",
      "fields": [
        {
          "name": "sku",
          "scalar": "string",
          "props": { "max_length": 64 },
          "sqlType": "VARCHAR(64)"
        },
        {
          "name": "tier_price",
          "scalar": null,
          "refType": "type:shop.core.Money",
          "props": {},
          "expandedFields": [
            { "name": "tier_price_amount", "scalar": "decimal", "sqlType": "NUMERIC(18,4)" },
            { "name": "tier_price_currency_code", "scalar": "string", "sqlType": "VARCHAR(3)" }
          ]
        }
      ]
    },
    {
      "name": "pricing",
      "owner": "ext:provider-b",
      "fields": [ ... ]
    }
  ]
}
```

### Extension 对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `entity` | string | 目标 entity identity |
| `groups` | Group[] | 扩展组列表 |

### Group 对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 组名（对应 ext 表的 `group_name`） |
| `owner` | string | 来源 owner（`platform` / `ext:<provider>` / `tenant:<id>`） |
| `fields` | ExtField[] | 组内字段 |

### ExtField 对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 字段名 |
| `scalar` | string? | 标量名（标量字段时）；struct/enum 引用时为 null |
| `refType` | string? | 引用的类型 identity（struct/enum 字段时）；标量字段时省略 |
| `props` | object | 类型参数 |
| `sqlType` | string? | 目标方言的 SQL 类型（标量字段时）。struct 字段时省略——看 `expandedFields` |
| `expandedFields` | ExpandedField[]? | struct 展开后的子字段（仅 struct 引用字段时） |

### ExpandedField 对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | JSON key 名（`<prefix>_<subfield>`） |
| `scalar` | string | 子字段标量名 |
| `sqlType` | string | 目标方言的 SQL 类型 |

## 完整示例

以下是 `loom project model --dialect pg examples/product/` 的输出：

```json
{
  "version": "loom-schema/v2",
  "dialect": "pg",
  "tables": [
    {
      "name": "products_base",
      "schema": "shop_core",
      "qualifiedName": "shop_core.products_base",
      "columns": [
        { "name": "id", "sqlType": "BIGINT", "scalar": "bigint", "props": {}, "required": true, "unique": false, "enumRef": null },
        { "name": "name", "sqlType": "VARCHAR(255)", "scalar": "string", "props": { "max_length": 255 }, "required": true, "unique": false, "enumRef": null },
        { "name": "base_price_amount", "sqlType": "NUMERIC(18,4)", "scalar": "decimal", "props": { "precision": 18, "scale": 4 }, "required": false, "unique": false, "enumRef": null },
        { "name": "base_price_currency_code", "sqlType": "VARCHAR(3)", "scalar": "string", "props": { "max_length": 3 }, "required": false, "unique": false, "enumRef": null }
      ],
      "primaryKey": ["id"],
      "indexes": [],
      "foreignKeys": [],
      "extension": {
        "strategy": "sidecar_eav",
        "extTable": "products_ext",
        "view": "products"
      }
    }
  ],
  "enums": [],
  "extensions": [
    {
      "entity": "entity:shop.core.Product",
      "groups": [
        {
          "name": "inventory",
          "owner": "ext:provider-a",
          "fields": [
            { "name": "sku", "scalar": "string", "props": { "max_length": 64 }, "sqlType": "VARCHAR(64)", "enumRef": null },
            { "name": "stock_qty", "scalar": "bigint", "props": {}, "sqlType": "BIGINT", "enumRef": null },
            { "name": "warehouse", "scalar": "string", "props": { "max_length": 32 }, "sqlType": "VARCHAR(32)", "enumRef": null }
          ]
        },
        {
          "name": "pricing",
          "owner": "ext:provider-b",
          "fields": [
            { "name": "discount_rate", "scalar": "decimal", "props": { "precision": 5, "scale": 2 }, "sqlType": "NUMERIC(5,2)", "enumRef": null },
            { "name": "tier_price", "scalar": null, "refType": "type:shop.core.Money", "props": {},
              "expandedFields": [
                { "name": "tier_price_amount", "scalar": "decimal", "sqlType": "NUMERIC(18,4)" },
                { "name": "tier_price_currency_code", "scalar": "string", "sqlType": "VARCHAR(3)" }
              ]
            }
          ]
        },
        {
          "name": "logistics",
          "owner": "ext:provider-b",
          "fields": [
            { "name": "shipping_weight", "scalar": "decimal", "props": { "precision": 10, "scale": 2 }, "sqlType": "NUMERIC(10,2)", "enumRef": null },
            { "name": "carrier", "scalar": "string", "props": { "max_length": 50 }, "sqlType": "VARCHAR(50)", "enumRef": null }
          ]
        }
      ]
    }
  ]
}
```

## 设计说明

1. **sqlType 是最终值**——消费方不需要自己做标量→SQL 映射。这意味着 `dialect` 字段
   不只是元数据，它直接决定了所有 `sqlType` 的值。

2. **struct 展开是显式的**——扩展字段如果是 struct 引用（如 Money），`scalar` 为
   null，`expandedFields` 列出展开后的子字段及其各自的 `sqlType`。消费方据此知道
   ext 表的 JSONB 文档里有哪些 key、每个 key 的类型。

3. **enum 关联是松耦合的**——Column 的 `enumRef` 是 identity 字符串，消费方通过遍历
   `enums` 数组查找对应的值列表。不内联到 column 里，避免重复。

4. **ext 表不单独列出**——ext 表的物理 DDL 是固定的（`base_id` + `scope` +
   `group_name` + `values` + `created_at`），不需要在 model JSON 里重复。`extension`
   对象的 `extTable` 字段告知表名即可。

5. **view 不单独描述**——view 的 DDL 由 `extensions` 的 groups 推导（每个 group 一个
   LEFT JOIN）。如果消费方需要 view 的完整 SQL，用 `loom project sql` 获取。
