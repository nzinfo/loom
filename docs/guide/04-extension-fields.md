# 04 · 扩展字段

扩展字段（extension_fields）让不同 provider 给同一个 entity 预声明自定义字段，
按组打包进 ext 表的 JSONB 列。这是 ERP 场景下灵活字段扩展的核心机制。

## 基本概念

### group——编译期的字段打包维度

多个扩展字段属于同一个 **group**，打包成 ext 表里的一行 JSONB。一个 `.ext.yaml`
文件 = 一个 group。group 名来自文件的 `group:` 字段（省略时默认 = 文件 stem）。

### scope——运行时的数据归属维度

ext 表的每一行数据属于某个 owner（platform / ext provider / tenant）。scope 用
hash 值标识数据归属，由应用写入时计算，loom 编译期不关心具体值。

## 定义扩展字段

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

| 字段 | 说明 |
|---|---|
| `entity` | 目标 entity（身份引用，带 `entity:` 前缀） |
| `group` | 组名（省略时 = 文件 stem） |
| `fields` | 扩展字段列表（语法同 table 的 fields） |

扩展字段支持所有类型——标量、struct（展开成多个 JSON key）、enum。

## 多 provider 叠加

多个 owner 可以给同一个 entity 写扩展字段，loom 收集所有并叠加。典型布局：

```
platform/shop/core/
  products.table.yaml          ← 平台基线
  product.entity.yaml

ext/provider-a/shop/core/
  product_inventory.ext.yaml   ← provider-A 的 inventory 组

ext/provider-b/shop/core/
  product_pricing.ext.yaml     ← provider-B 的 pricing 组
  product_logistics.ext.yaml   ← provider-B 的 logistics 组
```

一个 provider 可以给同一个 entity 贡献多个 group（多个 ext 文件）。不同 provider
的字段混在同一张 view 里。

### 同名字段冲突 = 硬错误

两个 owner 声明了同名字段（如都写 `sku`），loom **报错**，不覆盖、不合并、不按
优先级取舍。简单、无歧义。

## 物理结构（sidecar_eav）

ext 表的行维度是 `(base_id, scope, group_name)`：

```
┌─────────────────────┐         ┌──────────────────────────────────┐
│ products_base       │         │ products_ext                     │
│ (主表)              │ 1 ──── N │ (JSONB 扩展组表)                 │
├─────────────────────┤         ├──────────────────────────────────┤
│ id BIGINT PK        │ ◀────── │ base_id BIGINT  FK→base.id       │
│ name                │         │ scope BIGINT     (owner hash)     │
│ base_price_amount   │         │ group_name VARCHAR(50)            │
│ ...                 │         │ values JSONB                      │
└─────────────────────┘         │ created_at TIMESTAMPTZ           │
                                └──────────────────────────────────┘
```

行数 = 文件数（group 数）× scope 数。100 个字段拆到 5 个文件 → 每个 scope 5 行。

## view——LEFT JOIN + JSON 提取

entity 声明了 `view` 时，loom 生成联合视图。每个 group 一个 LEFT JOIN，用 JSON
提取把扩展字段展开成虚拟列：

```sql
CREATE VIEW products AS
SELECT u.id, u.name, ...,
  i.values->>'sku' AS sku,
  i.values->>'stock_qty' AS stock_qty,
  p.values->>'discount_rate' AS discount_rate
FROM products_base u
LEFT JOIN products_ext i ON i.base_id = u.id AND i.group_name = 'inventory'
LEFT JOIN products_ext p ON p.base_id = u.id AND p.group_name = 'pricing';
```

view 不按 scope 过滤——可见性是查询阶段的事（应用加 `WHERE scope = ...`）。

方言差异：pg 用 `->>'key'`，mysql 用 `` ->>'$.key' ``，sqlite 用
`json_extract(, '$.key')`。

## 谁能写扩展字段

| owner | 能写？ | 路径 |
|---|---|---|
| platform | ✓ | `platform/<sys>/<mod>/*.ext.yaml` |
| ext | ✓ | `ext/<provider>/<sys>/<mod>/*.ext.yaml` |
| tenant | ✓ | `tenants/<id>/<sys>/<mod>/*.ext.yaml` |

三种 owner 用完全相同的 `.ext.yaml` 机制，区别只在目录前缀。

---

下一步：[05 完整示例](./05-full-example.md) — `examples/product/` 全文解读。
