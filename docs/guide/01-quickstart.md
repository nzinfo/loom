# 01 · 快速上手

从零创建一个 schema，到投影出 SQL。5 分钟读完。

## 1. 创建目录结构

loom 的文件按 `<owner>/<system>/<module>/` 扁平放置，kind 编码在文件扩展名里：

```
my-shop/
└── platform/                 ← platform 是权威定义层
    └── shop/
        └── core/
            ├── bigint.type.yaml
            ├── string.type.yaml
            ├── decimal.type.yaml
            ├── money.type.yaml
            ├── products.table.yaml
            └── product.entity.yaml
```

## 2. 定义类型

每个类型是一个 `.type.yaml` 文件。先定义标量（系统的原子词汇），再定义复合类型：

```yaml
# platform/shop/core/decimal.type.yaml
version: loom-schema/v2
name: decimal
form: scalar
properties:
  - { name: precision, type: integer, required: true }
  - { name: scale, type: integer, required: true }
```

```yaml
# platform/shop/core/money.type.yaml
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

Money 是一个多字段结构体——引用它会展开成 `amount` + `currency_code` 两列。

> 标量（scalar）只能由 platform 定义，是全局共享的基础词汇。详见
> [02 类型系统](./02-types.md)。

## 3. 定义表

```yaml
# platform/shop/core/products.table.yaml
version: loom-schema/v2
name: Products
table:
  name: products_base
  extension:
    strategy: none              # 暂时不用扩展
using:
  - shop.core.*
fields:
  - { name: id, type: bigint, required: true }
  - name: name
    type: { ref: string, args: { max_length: 255 } }
    required: true
  - name: price
    type: shop.core.Money       # → price_amount + price_currency_code
primary_key: [id]
```

## 4. 定义实体

entity 给表加上业务身份：

```yaml
# platform/shop/core/product.entity.yaml
version: loom-schema/v2
name: Product
primary_table: table:shop.core.Products
business_keys: [name]
```

## 5. 校验

```sh
loom check my-shop/
```

无输出 = 通过。

## 6. 投影

```sh
loom project sql --dialect pg my-shop/
```

输出：

```sql
CREATE TABLE shop_core.products_base (
  id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  price_amount NUMERIC(18,4),
  price_currency_code VARCHAR(3),
  PRIMARY KEY (id)
);
```

试试其他方言：

```sh
loom project sql --dialect mysql my-shop/
loom project sql --dialect sqlite my-shop/
```

---

下一步：[02 类型系统](./02-types.md) — 了解 18 种内置标量、结构体、枚举、using 导入。
