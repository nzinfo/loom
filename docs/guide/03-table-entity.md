# 03 · 表与实体

table 承载物理结构，entity 在 table 之上加业务身份。两者配合构成完整的数据模型。

## table

```yaml
# platform/shop/core/products.table.yaml
version: loom-schema/v2
name: Products
table:
  name: products_base
  extension:
    strategy: sidecar_eav
    ext_table: products_ext
using:
  - shop.core.*
fields:
  - { name: id, type: bigint, required: true }
  - name: name
    type: { ref: string, args: { max_length: 255 } }
    required: true
  - name: base_price
    type: shop.core.Money
primary_key: [id]
indexes:
  - { name: idx_products_name, fields: [name], unique: true }
foreign_keys:
  - name: fk_orders_user
    fields: [user_id]
    ref_table: users_base
    ref_fields: [id]
    on_delete: cascade
```

### 字段

每个字段有 `name` 和 `type`。可选属性：

| 属性 | 说明 |
|---|---|
| `required: true` | NOT NULL |
| `unique: true` | UNIQUE 约束 |
| `column` | 物理列名覆盖（见下文） |

### column——控制物理列名

struct 引用展开时，`column` 控制列名行为：

| column 值 | 效果 | 例子 |
|---|---|---|
| 省略 | 用字段名作前缀 | `base_price` → `base_price_amount` |
| `''`（空字符串） | flatten：子字段直接插入，无前缀 | audit → `created_at`, `updated_at` |
| `'foo'` | 用 foo 作前缀 | → `foo_amount`, `foo_currency_code` |

flatten 的典型用途是审计字段：

```yaml
- name: audit
  type: shop.core.Audit
  column: ''          # → created_at, updated_at（无前缀）
```

### 主键、索引、外键

```yaml
primary_key: [id]
indexes:
  - { name: idx_email, fields: [email], unique: true }
foreign_keys:
  - name: fk_orders_user
    fields: [user_id]
    ref_table: users_base
    ref_fields: [id]
    on_delete: cascade          # cascade | restrict | set_null | no_action
```

### 扩展策略

`table.extension.strategy` 决定如何承载自定义扩展字段：

| strategy | 物理布局 | 适用场景 |
|---|---|---|
| `none` | 单表 | 无扩展字段 |
| `sidecar_eav` | base 表 + ext 表 + view | 有扩展字段（ERP 场景推荐） |

`sidecar_eav` 时，ext 表名默认 = `<table>_ext`，可用 `ext_table` 自定义。

### physical_schema

物理 schema 名从模块路径派生：`shop.core` → `shop_core`。可用 CLI 覆盖：

```sh
loom project sql --dialect pg --physical-schema shop.core=acme_shop my-shop/
```

## entity

entity 给 table 加上业务身份元数据。它的核心作用是**扩展字段的锚点**——所有扩展
字段都挂在 entity 上。

```yaml
# platform/shop/core/product.entity.yaml
version: loom-schema/v2
name: Product
primary_table: table:shop.core.Products
business_keys: [name]
view: products
```

| 字段 | 说明 |
|---|---|
| `primary_table` | 指向一张 table（身份引用，带 `table:` 前缀） |
| `business_keys` | 业务唯一标识（区别于主键 id） |
| `view` | 逻辑视图名（sidecar_eav 时创建 base + ext 联合视图） |

**entity 不重复定义 fields**——fields 由 table 负责，避免双重真理源。entity 只加
业务元数据。

### view

当 table 的扩展策略是 `sidecar_eav` 时，entity 上声明 `view` 会生成一个联合视图，
把 base 表的列和 ext 表的扩展字段合并到一起。应用代码用 view 名（如 `products`），
不直接访问 `_base` / `_ext`。

---

下一步：[04 扩展字段](./04-extension-fields.md) — JSONB 扩展组、多 provider 叠加。
