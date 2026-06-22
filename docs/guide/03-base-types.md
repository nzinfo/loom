# type：类型定义（scalar / struct / enum）

loom 的所有类型定义都用**同一个 kind `type`**，通过 `form` 字段区分三种形态。
每个类型是**一个文件**——不再有 `base_types`（集合）与 `value_type`（单体）的区分。

| form | 用途 | 命名约定 | 文件数 |
|---|---|---|---|
| `scalar` | 系统标量（基底词汇） | 小写 `bigint` / `decimal` / `string` | 每个 scalar 一个文件 |
| `struct` | 用户复合类型（newtype / 多字段） | PascalCase `Email` / `Money` | 每个类型一个文件 |
| `enum` | 枚举（sum type） | PascalCase `Status` | 每个类型一个文件 |

扩展名统一为 `.type.yaml`。身份前缀统一为 `type:`（如 `type:base.core.Money`）。

> 设计动机见 `docs/design/2026-06-21-unified-type-kind-notes.md`：消除
> `base_types`（唯一"集合 kind"）与 `value_type`（单体）的形态不对称，让标量与
> 复合类型用同一个 kind、同一个扩展名、同一条身份前缀表达。

## form: scalar —— 系统标量

标量是 loom 的"原子词汇表"——所有字段最终落到某个标量。标量只由 platform 定义，
全局共享。

```yaml
# platform/base/core/decimal.type.yaml
version: loom-schema/v2
name: decimal
form: scalar
description: fixed-point
properties:
  - { name: precision, type: integer, required: true }
  - { name: scale, type: integer, required: true }
```

```yaml
# platform/base/core/bigint.type.yaml
version: loom-schema/v2
name: bigint
form: scalar
description: 64-bit integer
properties: []
```

**设计取向**：

- 标量只列**逻辑类型名 + 抽象属性**（`decimal` 有 `precision/scale`，`string` 有
  `max_length`），**不绑定方言**
- 方言映射在投影器里集中管理（`decimal` → PG `NUMERIC(18,4)` / MySQL `DECIMAL(18,4)`
  / SQLite `NUMERIC`）
- 标量**不可由 ext/tenant 扩展**：想加新标量，需 platform 加 `.type.yaml` 文件
  并 bump 版本号
- **properties** 是 validate 的依据：标量声明 `precision` 为 required 后，引用方在
  `type.args` 里漏写 `precision` 会被编译期校验拦下

`string.type.yaml` 唯一合法位置在 `platform/base/core/` 下——它是全局共享的，ext 和
tenant 都不能定义自己的标量（详见 [01 目录与身份](./01-layout-and-identity.md)）。

### 标量的"基底性"= base.core 是默认命名空间

标量短名（`decimal`、`string`）全局可用，**不是**因为标量"特殊"——而是因为
`base.core` 是每个文件隐含的默认导入命名空间（`using: [base.core.*]`）。标量恰好
定义在 `base.core` 下，所以全局可见。这跟 struct/enum 完全对称：base.core 的 struct
（如 `Email`）也默认全局可用。

类比 Java 的 `java.lang.*`：`int` 全局可用不是因为 `int` 特殊，而是因为
`java.lang` 默认导入且 `int` 恰好在里面。短名解析**只有一条路径**——查 using 命名空间，
不分 scalar/struct/enum。详见 [04 类型引用 §短名解析规则](./04-type-refs.md#短名解析规则)。

### 推荐内置标量

loom 不预置标量目录——由 platform schema 自己声明。常见推荐：

| scalar | properties | 说明 |
|---|---|---|
| `bigint` | — | 64-bit 整数 |
| `integer` | — | 32-bit 整数 |
| `decimal` | `precision` (req), `scale` (req) | 定点数 |
| `string` | `max_length` (req), `pattern` | 变长字符串 |
| `text` | — | 长文本 |
| `boolean` | — | 布尔 |
| `date` | — | 日期 |
| `datetime` | — | 时间戳 |
| `bytes` | `max_length` (req) | 二进制 |

## form: struct —— 复合类型

struct 是用户定义的"语义类型"，解决两件事：

1. **newtype 包装**：给 scalar 加语义标签（`Email = string` + 长度），避免把
   `user_email` 和 `invoice_email` 当成同一种 string 混用
2. **多字段映射**：一个业务概念需要多列才能完整表达（如 Money = amount + currency）

### 单字段 struct（newtype）

内部字段名**必须叫 `value`**，这样投影才不附加后缀：

```yaml
# platform/base/core/email.type.yaml
version: loom-schema/v2
name: Email
form: struct
display_name: 邮箱
fields:
  - name: value
    type:
      ref: string
      args: { max_length: 254 }
```

引用它，列名 = 字段名（无后缀）：

```yaml
fields:
  - name: email
    type: base.core.Email
    required: true
    unique: true
# → 物理：email VARCHAR(254)（用 Email 内部声明的 max_length: 254）
```

newtype 的约束（如 `max_length: 254`）属于**类型定义本身**，引用方不可覆盖。
想要不同约束，定义一个新类型：

```yaml
# short-email.type.yaml
name: ShortEmail
form: struct
fields:
  - name: value
    type: { ref: string, args: { max_length: 100 } }
```

```yaml
fields:
  - name: email
    type: base.core.Email           # 用 Email 的 254
  - name: short
    type: base.core.ShortEmail      # 用 ShortEmail 的 100
```


### 多字段 struct

```yaml
# platform/base/core/money.type.yaml
version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type:
      ref: decimal
      args: { precision: 18, scale: 4 }
    required: true
  - name: currency_code
    type:
      ref: string
      args: { max_length: 3 }
    required: true
```

引用它，**列名 = `<前缀>_<子字段>`**：

```yaml
fields:
  - name: balance
    type: base.core.Money
# → 物理：balance_amount NUMERIC(18,4), balance_currency_code VARCHAR(3)
```

## form: enum —— 枚举

```yaml
# platform/base/core/status.type.yaml
version: loom-schema/v2
name: Status
form: enum
variants:
  - value: active
    display_name: Active
  - value: inactive
  - value: suspended
```

enum 投影成单列，底层标量是 `string`，由 `enumRef` 驱动方言（PG `CREATE TYPE`、
MySQL `ENUM(...)`、SQLite `CHECK IN`）。

> enum 是三个 form 里**最可能演进**的——未来可能变为 Rust 风格带关联数据的代数
> 类型。当前实现只支撑 `variants`。

## 投影规则速查

| form | 内部字段名 | 引用时列数 | 列名规则 |
|---|---|---|---|
| scalar | — | 1 | 引用字段名 |
| struct 单字段 newtype | `value` | 1 | 引用字段名（无后缀） |
| struct 多字段 | 任意 | N | `<引用字段名>_<子字段名>` |
| enum | — | 1 | 引用字段名（底层 string） |


## 校验规则（编译期）

`form` ↔ 专属字段的互斥矩阵由 schema 的 `superRefine` 强制：

| 字段 | scalar | struct | enum |
|---|---|---|---|
| `properties` | ✓ | ✗ | ✗ |
| `fields` | ✗ | ✓ 必填 | ✗ |
| `variants` | ✗ | ✗ | ✓ 必填 |
| `constraints` | ✗ | ✓ 可选 | ✗ |
| **name 大小写** | 小写 `/^[a-z]/` | PascalCase `/^[A-Z]/` | PascalCase `/^[A-Z]/` |

命名约定是**编译期强制**的——scalar 名必须小写，struct/enum 名必须 PascalCase。
