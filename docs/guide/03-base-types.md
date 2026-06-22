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

newtype 的本质是"标量 + 语义标签"。struct 内部声明的 args（如 `max_length: 254`）是
**默认约束**；引用方可以传 args **覆盖/收紧**（按 key 覆盖，引用方优先）：

```yaml
fields:
  - name: short_email
    type:
      ref: base.core.Email
      args: { max_length: 100 }     # ← 覆盖 Email 的默认 254
# → 物理：short_email VARCHAR(100)
```

```yaml
fields:
  - name: raw_email
    type: base.core.Email           # ← 不传 args，用默认 254
# → 物理：raw_email VARCHAR(254)
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
> 类型。当前实现只支撑 `variants`，但 `type_parameters` 对 enum 开放（为参数化 enum
> 如 `Result<T,E>` 预留）。详见设计记录 §3.1。

## 投影规则速查

| form | 内部字段名 | 引用时列数 | 列名规则 |
|---|---|---|---|
| scalar | — | 1 | 引用字段名 |
| struct 单字段 newtype | `value` | 1 | 引用字段名（无后缀） |
| struct 多字段 | 任意 | N | `<引用字段名>_<子字段名>` |
| enum | — | 1 | 引用字段名（底层 string） |

## type_parameters：参数化类型（struct / enum）

当一个 struct/enum 的内部字段类型本身需要由引用方决定时，用 `type_parameters`
声明类型参数，让它成为"泛型类型"。scalar 不接受 type_parameters。

```yaml
# platform/base/core/range.type.yaml
version: loom-schema/v2
name: Range
form: struct
type_parameters:
  - name: T
    constraint: value              # type | value（默认 type）
    default: base.core.bigint
    description: element type
fields:
  - name: low
    type: T                        # 引用类型参数
  - name: high
    type: T
```

- **`name`**：参数标识符。在 fields 里以 `type: <name>` 引用
- **`constraint`**：
  - `value`：实参必须是具体类型（标量短名或类型 fqn）
  - `type`（默认）：实参可为任何类型，含另一个类型参数（用于泛型递归 `Map<K,V>`）
- **`default`**：引用方未传该参数时使用

引用方在 `type.args` 里以 `{ <ParamName>: <TypeRef> }` 传实参：

```yaml
fields:
  - name: price_range
    type:
      ref: base.core.Range
      args: { T: decimal }
# → price_range_low NUMERIC, price_range_high NUMERIC
```

> **类型参数与值参数共享 `type.args`**：`max_length`（值参数）和 `T`（类型参数）
> 都写在 args 里，加载器按"是否为声明的 type parameter 名"区分。

详见 [04 类型引用与 using](./04-type-refs.md)。

## 校验规则（编译期）

`form` ↔ 专属字段的互斥矩阵由 schema 的 `superRefine` 强制：

| 字段 | scalar | struct | enum |
|---|---|---|---|
| `properties` | ✓ | ✗ | ✗ |
| `fields` | ✗ | ✓ 必填 | ✗ |
| `variants` | ✗ | ✗ | ✓ 必填 |
| `type_parameters` | ✗ | ✓ 可选 | ✓ 可选 |
| `constraints` | ✗ | ✓ 可选 | ✗ |
| **name 大小写** | 小写 `/^[a-z]/` | PascalCase `/^[A-Z]/` | PascalCase `/^[A-Z]/` |

命名约定是**编译期强制**的——scalar 名必须小写，struct/enum 名必须 PascalCase。
