# 05 · 完整示例

`examples/product/` 是一个完整的 schema，展示一个 entity、两个 ext provider、三个
扩展组。本篇逐一解读。

## 目录结构

```
examples/product/
├── platform/shop/core/
│   ├── bigint.type.yaml            ← 标量
│   ├── string.type.yaml
│   ├── decimal.type.yaml
│   ├── money.type.yaml             ← 结构体（多字段）
│   ├── products.table.yaml         ← 物理表
│   └── product.entity.yaml         ← 实体
├── ext/provider-a/shop/core/
│   └── product_inventory.ext.yaml  ← provider-A: 1 个组（inventory）
└── ext/provider-b/shop/core/
    ├── product_pricing.ext.yaml    ← provider-B: 组 1（pricing）
    └── product_logistics.ext.yaml  ← provider-B: 组 2（logistics）
```

## 标量定义

```yaml
# bigint.type.yaml
version: loom-schema/v2
name: bigint
form: scalar
description: 64-bit integer
properties: []
```

`string`、`decimal` 同理。标量是系统基础词汇，只能由 platform 定义。

## 结构体：Money

```yaml
# money.type.yaml
version: loom-schema/v2
name: Money
form: struct
using:
  - shop.core.*
fields:
  - name: amount
    type: { ref: decimal, args: { precision: 18, scale: 4 } }
    required: true
  - name: currency_code
    type: { ref: string, args: { max_length: 3 } }
    required: true
```

引用 Money 会展开成两列（`<前缀>_amount` + `<前缀>_currency_code`）。

## 表：products_base

```yaml
# products.table.yaml
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
```

`base_price`（Money）展开成 `base_price_amount` + `base_price_currency_code`。

## 实体：Product

```yaml
# product.entity.yaml
version: loom-schema/v2
name: Product
primary_table: table:shop.core.Products
business_keys: [name]
view: products
```

声明了 `view: products`——投影时会生成联合视图。

## 扩展字段

### provider-A：inventory 组

```yaml
# ext/provider-a/shop/core/product_inventory.ext.yaml
version: loom-schema/v2
entity: entity:shop.core.Product
group: inventory
using:
  - shop.core.*
fields:
  - { name: sku, type: { ref: string, args: { max_length: 64 } } }
  - { name: stock_qty, type: bigint }
  - { name: warehouse, type: { ref: string, args: { max_length: 32 } } }
```

### provider-B：pricing 组 + logistics 组

```yaml
# ext/provider-b/shop/core/product_pricing.ext.yaml
version: loom-schema/v2
entity: entity:shop.core.Product
group: pricing
using:
  - shop.core.*
fields:
  - { name: discount_rate, type: { ref: decimal, args: { precision: 5, scale: 2 } } }
  - { name: tier_price, type: shop.core.Money }
```

```yaml
# ext/provider-b/shop/core/product_logistics.ext.yaml
version: loom-schema/v2
entity: entity:shop.core.Product
group: logistics
using:
  - shop.core.*
fields:
  - { name: shipping_weight, type: { ref: decimal, args: { precision: 10, scale: 2 } } }
  - { name: carrier, type: { ref: string, args: { max_length: 50 } } }
```

`tier_price`（Money）在 JSONB 里展开成 `tier_price_amount` + `tier_price_currency_code`
两个 key。

## 投影输出（PG）

```sh
loom project sql --dialect pg examples/product/
```

```sql
CREATE TABLE shop_core.products_base (
  id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  base_price_amount NUMERIC(18,4),
  base_price_currency_code VARCHAR(3),
  PRIMARY KEY (id)
);

CREATE TABLE shop_core.products_ext (
  base_id BIGINT NOT NULL,
  scope BIGINT NOT NULL,
  group_name VARCHAR(50) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE VIEW products AS
SELECT
  u.id, u.name, u.base_price_amount, u.base_price_currency_code,
  l.values->>'shipping_weight' AS shipping_weight,
  l.values->>'carrier' AS carrier,
  p.values->>'discount_rate' AS discount_rate,
  p.values->>'tier_price_amount' AS tier_price_amount,
  p.values->>'tier_price_currency_code' AS tier_price_currency_code,
  i.values->>'sku' AS sku,
  i.values->>'stock_qty' AS stock_qty,
  i.values->>'warehouse' AS warehouse
FROM shop_core.products_base u
LEFT JOIN products_ext l ON l.base_id = u.id AND l.group_name = 'logistics'
LEFT JOIN products_ext p ON p.base_id = u.id AND p.group_name = 'pricing'
LEFT JOIN products_ext i ON i.base_id = u.id AND i.group_name = 'inventory';
```

三个组各一个 LEFT JOIN：logistics 和 pricing 来自 provider-B，inventory 来自
provider-A。

## 字段检视

```sh
loom fields examples/product/ entity:shop.core.Product
```

```
entity: shop.core.Product
table: products_base

── base fields ──────────────────────────
  id                       bigint
  name                     string(255)
  base_price_amount        decimal(18,4)
  base_price_currency_code string(3)

── group: logistics (ext:provider-b) ────
  shipping_weight          decimal(10,2)
  carrier                  string(50)

── group: pricing (ext:provider-b) ──────
  discount_rate            decimal(5,2)
  tier_price_amount        decimal(18,4)
  tier_price_currency_code string(3)

── group: inventory (ext:provider-a) ────
  sku                      string(64)
  stock_qty                bigint
  warehouse                string(32)
```

---

下一步：[06 CLI 命令](./06-cli.md) — 完整命令参考。
