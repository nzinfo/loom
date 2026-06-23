# 02 · 类型系统

loom 的所有类型用同一个 `type` kind，通过 `form` 字段区分三种形态。每个类型是一个
`.type.yaml` 文件。

## 三种 form

| form | 用途 | 命名 | 例子 |
|---|---|---|---|
| `scalar` | 系统标量（基底词汇） | 小写 | `decimal`、`string`、`bigint` |
| `struct` | 复合类型 | PascalCase | `Money`、`Email` |
| `enum` | 枚举 | PascalCase | `Status`、`OrderType` |

`form` 决定了文件里写什么：scalar 写 `properties`，struct 写 `fields`，enum 写
`variants`。三者互斥。

## 内置标量（18 种，对齐 CDS）

标量是 loom 的原子词汇——所有字段最终落到某个标量。标量只能由 platform 定义，
全局共享。

| 标量 | 说明 | 参数 |
|---|---|---|
| `uuid` | UUID | — |
| `boolean` | 布尔 | — |
| `uint8` | 无符号 8-bit 整数 | — |
| `int16` | 16-bit 整数 | — |
| `integer` | 32-bit 整数 | — |
| `bigint` | 64-bit 整数 | — |
| `decimal` | 定点数 | precision, scale |
| `double` | 双精度浮点 | — |
| `string` | 变长字符串 | max_length, pattern |
| `largestring` | 无限长字符串 | — |
| `date` | 日期 | — |
| `time` | 时间 | — |
| `datetime` | 时间戳 | — |
| `timestamp` | 高精度时间戳 | — |
| `binary` | 定长二进制 | max_length |
| `largebinary` | 无限长二进制 | — |
| `vector` | 向量嵌入 | length |
| `map` | 键值映射 | — |

标量的参数在引用时通过 `args` 传入：

```yaml
- name: price
  type: { ref: decimal, args: { precision: 18, scale: 4 } }
```

声明了 `required` 的参数（如 `decimal` 的 precision/scale，`string` 的 max_length）
必须传，否则校验报错。

> 完整的标量→SQL 方言映射见 [SPEC.md](../SPEC.md) §4。

## struct（结构体）

struct 是用户定义的"语义类型"，解决两个需求：

### 单字段 newtype——给标量加语义标签

```yaml
# email.type.yaml
version: loom-schema/v2
name: Email
form: struct
fields:
  - name: value
    type: { ref: string, args: { max_length: 254 } }
```

单字段 struct 的内部字段名必须叫 `value`。引用时列名 = 字段名（无后缀）：

```yaml
- name: contact_email
  type: shop.core.Email
# → contact_email VARCHAR(254)
```

### 多字段——一个概念需要多列

```yaml
# money.type.yaml
version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type: { ref: decimal, args: { precision: 18, scale: 4 } }
    required: true
  - name: currency_code
    type: { ref: string, args: { max_length: 3 } }
    required: true
```

引用时展开成多列，列名 = `<字段名>_<子字段名>`：

```yaml
- name: price
  type: shop.core.Money
# → price_amount NUMERIC(18,4), price_currency_code VARCHAR(3)
```

### newtype 的约束属于类型定义

newtype 的参数（如 Email 的 `max_length: 254`）属于**类型定义本身**，引用方不能
覆盖。想要不同约束，定义一个新类型。

## enum（枚举）

```yaml
# status.type.yaml
version: loom-schema/v2
name: Status
form: enum
variants:
  - { value: active, display_name: Active }
  - { value: inactive }
  - { value: suspended }
```

引用时投成单列（底层标量是 string）：

```yaml
- name: status
  type: shop.core.Status
```

方言映射：pg 用 `CREATE TYPE ... AS ENUM`，mysql 用 `ENUM(...)`，sqlite 用
`TEXT + CHECK`。

## 类型引用与 using 导入

### 两种引用形式

| 形式 | 语法 | 含义 |
|---|---|---|
| 短名 | `Money`（无点） | 通过 using 命名空间解析 |
| 全限定 | `shop.core.Money`（两个点） | 直接指向类型，不走 using |

### using 声明

每个文件可以声明自己的 using 列表，控制短名解析范围：

```yaml
using:
  - shop.core.*       # 导入 shop.core 下所有类型
  - base.core.Email   # 精确导入单个类型
```

**隐含默认**：每个文件自动包含 `base.core.*`——所以 `string`、`decimal` 等基础标量
以及 `base.core` 下的 struct/enum 都可以全局用短名引用。

如果你把标量定义在 `shop.core` 下（如快速上手示例），引用方需要 `using:
[shop.core.*]` 才能用短名。

### 歧义处理

两个命名空间都有同名类型时，用全限定名绕开：

```yaml
- name: total
  type: shop.core.Money     # 全限定，不走 using
```

---

下一步：[03 表与实体](./03-table-entity.md) — 定义物理表、业务实体、字段展开规则。
