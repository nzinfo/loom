# base_types：可用标量目录

`base_types.yaml` 是整个系统的"原子词汇表"——所有 value_type、table field、
entity field 最终都要落到这些标量之一。

## 设计取向

- base_types 只列**逻辑类型名 + 抽象属性**（如 `decimal` 有 `precision/scale`，
  `string` 有 `max_length`），**不绑定方言**
- 方言映射在投影器里集中管理（`decimal` → PG `NUMERIC(18,4)` / MySQL `DECIMAL(18,4)`
  / SQLite `NUMERIC`）
- v2 内**不可扩展**：想加新标量，需改 base_types.yaml + 投影器并 bump 版本号

## 推荐内置标量

```yaml
scalars:
  - { name: boolean,   description: 布尔值, properties: [] }
  - { name: integer,   description: 整数, properties: [{name: min, type: integer}, {name: max, type: integer}] }
  - { name: bigint,    description: 64位整数, properties: [] }
  - name: decimal
    description: 定点小数（金额、计量）
    properties:
      - { name: precision, type: integer, required: true }
      - { name: scale, type: integer, required: true }
  - name: string
    description: 变长字符串
    properties:
      - { name: max_length, type: integer, required: true }
      - { name: pattern, type: string }
  - { name: text, description: 长文本, properties: [] }
  - { name: datetime, description: 时间戳, properties: [] }
  - { name: date, description: 日期, properties: [] }
  - { name: uuid, description: UUID, properties: [{name: version, type: integer}] }
  - { name: bytes, description: 二进制, properties: [{name: max_length, type: integer}] }
  - { name: json, description: JSON, properties: [] }
```

> **注意**：v2 不再为枚举保留 `enum` 标量。枚举（求和类型）由 value_type 的
> `variants` 顶层形态表达，详见 [06 table](./06-table.md) §variants。

## 关键约束

- **唯一权威**：value type / table field 引用的 scalar 必须在此声明，否则报
  `unknown scalar` 错误（v2 把所有字段统一到 `type:` 键，scalar 通过短名或
  `base.core.<Scalar>` 全限定名引用）
- **不出现方言**：base_types 不写 `pg: NUMERIC`，由投影器决定
- **属性有类型**：属性自身用 base_type（递归闭包），保证可校验

## 位置约束

base_types.yaml 唯一合法位置是 `platform/base/core/base_types.yaml`——它是全局
共享的，ext 和 tenant 都不能定义自己的 base_types（详见
[01 目录与身份](./01-layout-and-identity.md)）。
