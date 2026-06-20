# value_type：语义类型包装

value_type 是用户定义的"语义类型"，介于 base_type scalar 和 field 之间，解决两件事：

1. **newtype 包装**：给 scalar 加语义标签（`Email = string` + 正则 + 长度），避免
   把 `user_email` 和 `invoice_email` 当成同一种 string 混用
2. **多字段映射**：一个业务概念需要多列才能完整表达（如 Money = amount + currency）

## 单字段 value_type（newtype）

内部字段名**必须叫 `value`**，这样投影才不附加后缀：

```yaml
# platform/base/core/email.value_type.yaml
version: loom-schema/v2
name: Email
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
# → 物理：email VARCHAR(254)
```

也可以在文件顶部用 `using:` 导入后写短名（详见 [using 导入机制](#using-导入机制)）：

```yaml
using:
  - base.core.*
fields:
  - name: email
    type: Email                       # 短名，等价于 base.core.Email
```

## 多字段 value_type

```yaml
# platform/base/core/money.value_type.yaml
version: loom-schema/v2
name: Money
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

## 投影规则速查

| value_type 形态 | 内部字段名 | 引用时列数 | 列名规则 |
|---|---|---|---|
| 单字段 newtype | `value` | 1 | 引用字段名（无后缀） |
| 多字段 | 任意 | N | `<引用字段名>_<子字段名>` |

投影规则本身与 v1 一致，只是输入语法的 `base`/`ref` 键合并成了单一 `type:`。

## 单一 `type:` 键

v2 取消了 v1 的 `base` / `ref` 互斥约束，改为**单一 `type:` 键**。任何 field 元素
（value_type / table / mixin / extension_fields 内）都只有一个类型键：

```yaml
fields:
  - name: age
    type: integer                     # 单段短名 → base_types 标量
  - name: email
    type: base.core.Email             # 三段全限定名 → value_type 节点
```

加载器按**点号数量**区分两种形态（详见 spec §3.2）：

| 形态 | 形式 | 含义 | 解析路径 |
|---|---|---|---|
| 短名 | `integer` / `string`（无点） | base_types 标量 | 查 base_types 注册表 |
| 全限定 | `base.core.Email`（两个点） | value_type 节点 | 查节点表，验证 `kind === 'value_type'` |

**为什么这么设计**：`integer`（内置标量）和 `base.core.Email`（用户定义的 value_type）
从类型论看是同类东西——都是"类型"。"是不是类型"由被引用节点自身的 `kind` 决定，
引用者只需说"我的类型是 X"，不需要再标 kind 前缀。

### Type Descriptor：详写形式

`type:` 除了裸字符串简写，还可以写成**结构化对象**：

```yaml
- name: email
  type:
    ref: string
    args: { max_length: 254 }
    meta: { since: v0.2.0 }
```

| 键 | 作用 | 备注 |
|---|---|---|
| `ref` | 类型引用（同简写字符串） | 单段=标量短名，三段=value_type fqn |
| `args` | 类型参数 | 所有标量参数都收拢在此，不再写 field 顶层 |
| `meta` | 元数据黑袋（`since`/`deprecated`/标签） | v2 不校验内容 |

简写 `type: integer` 在 link 阶段被规范化为 `{ ref: 'integer' }`，下游 pass 看到的
一律是对象。两种形式语义等价，但**带参数时必须用详写**（参数无处可放）。

**错误情况**：

- field 没有 `type:` → `field must have a type`
- `type: foo.bar.Baz` 节点不存在 → `unknown type "foo.bar.Baz"`
- `type: foo.bar.Baz` 目标 kind 不是 value_type →
  `type reference "foo.bar.Baz" resolves to kind=entity, expected value_type`
- `type: integer` base_types 里没有 → `unknown scalar "integer"`
- 在 field 顶层写 `max_length`、`precision` 等参数键 → `Unrecognized key(s) in object`
  （v2 要求参数走 `type.args`）

---

## using 导入机制

v2 引入编程语言式的 `using:` 导入机制（类比 C# `using`、Java `import`、Go `import`），
让你用短名引用 value_type，不必每次写三段全限定名。

### 动机

`type: base.core.Email` 比 v1 的 `ref: value_type:base.core.Email` 干净，但每次
都写三段名仍然啰嗦。using 提供：

- **可读性**：`type: Money` 比 `type: base.core.Money` 干净
- **模块边界自文档化**：using 列表显式声明"这个文件依赖哪些模块的类型"
- **重构友好**：移动 value_type 到另一模块，改 using 而非改所有引用处
- **LSP / 补全友好**：using 列表给工具明确的补全范围

### 文件级声明

每个 .yaml 文件**顶部**声明自己的 using 列表（类比 C# per-file `using`，而非 Go
package-level `import`）。模块内的不同文件可以有不同 using——更灵活，避免一个文件
引入整个模块不需要的依赖。

```yaml
# ext/acme-corp/retail/pos/orders.table.yaml
version: loom-schema/v2
name: Orders
using:
  - base.core.*                       # 导入 base.core 命名空间下所有类型
  - retail.pos.types.*                # 导入 retail.pos.types 命名空间下所有类型
fields:
  - name: id
    type: bigint                      # 默认导入的 base_types 短名
  - name: contact_email
    type: Email                       # 经 using 短名，等价 base.core.Email
  - name: total
    type: Money                       # 经 using 短名，等价 retail.pos.types.Money
```

using 列表为空时可省略 `using:` 键。

### 默认导入：`base.core.*`

每个文件**隐含** `using: [base.core.*]`，base_types 标量在任何文件里都可以直接用
短名（`integer`、`string`、`decimal`、`enum`、`datetime`...），无需显式声明。

类比 Java 默认 `java.lang.*`、C# 默认 `System`、Go 的 builtins。

### A 与 B 统一语法

A（命名空间通配导入）和 B（精确名导入）在语法上**统一为同一个机制**——都是
"全限定路径 + 可选通配后缀"：

```yaml
using:
  - base.core.*              # A：导入 base.core 命名空间下所有类型
  - retail.pos.types.*       # A：另一个模块全部
  - base.core.Email          # B：精确导入单个类型
  - base.core.Money          # B：另一个精确
```

末尾 `.*` = 命名空间通配；无 `.*` = 精确名。加载器按末尾是否 `.*` 分流，但词法
形态一致——这就是"A 与 B 统一"。

**何时用哪种**：

- A（`ns.*`）：文件用到一个模块的大量类型，省得逐一列举
- B（`ns.Name`）：文件只用到一两个类型，精确导入更显式、更易追踪依赖

两种形态可以混用，但在同一文件内**不要对同一命名空间同时写** `ns.*` 和 `ns.Name`
（精确名会被通配覆盖，多余）。

### 短名解析规则

加载器看到 `type: X`，按以下顺序解析（详见 spec §4.6）：

1. **形态分流**：单段（无点）走短名解析；三段（两个点）走全限定解析。
2. **短名解析**：
   - 先查 base_types 注册表（默认 `base.core.*` 导入）→ 命中即内置标量
   - 再查当前文件 using 列表：
     - 遍历每条 using，若为 `<ns>.*` 则在 `<ns>.X` 处查节点；若为精确名则直接匹配
     - 若短名在多个 using 命名空间命中 → 报
       `ambiguous type reference "X", candidates: ...`
     - 若都没命中 → 报 `unknown type "X"`
3. **全限定解析**：
   - 直接按 `sys.mod.Name` 查节点表
   - 验证目标节点 `kind === 'value_type'`，否则报
     `resolves to kind=..., expected value_type`
   - 不存在 → 报 `unknown type "sys.mod.Name"`
   - **全限定引用不走 using**（已经全限定了）

### 歧义检测

两个模块都有 `Money` 时，using 通配会撞名：

```yaml
using:
  - base.core.*
  - retail.pos.types.*
fields:
  - name: total
    type: Money              # 命中 base.core.Money 和 retail.pos.types.Money
# → 报错：ambiguous type reference "Money", candidates: base.core.Money, retail.pos.types.Money
```

解决办法：用全限定名绕开 using 解析：

```yaml
fields:
  - name: total
    type: retail.pos.types.Money    # 全限定，不走 using
```

### 形态 C（重命名）：挂起

形态 C 用于命名冲突消解（在文件内给某个类型起别名）。**v2 不实现**，语法待定。
冲突的临时解决办法就是上一节的全限定名。详见 spec §4.5。

### using 的校验

- using 条目的命名空间或精确名必须存在 → 否则 `unknown using target "..."`
- using 列表为空时可省略 `using:` 键

---

## type_parameters：参数化 value_type

当一个 value_type 的内部字段类型本身需要由引用方决定时，用 `type_parameters`
声明类型参数，让它成为"泛型 value_type"。

### 声明

```yaml
# platform/base/core/range.value_type.yaml
version: loom-schema/v2
name: Range
type_parameters:
  - name: T
    constraint: value              # type | value（默认 type）
    default: base.core.bigint
    description: 元素类型
fields:
  - name: low
    type: T                        # 引用类型参数
  - name: high
    type: T
```

- **`name`**：参数标识符。在 fields 里以 `type: <name>` 引用
- **`constraint`**：
  - `value`：实参必须是具体类型（标量短名或 value_type fqn）
  - `type`（默认）：实参可为任何类型，含另一个类型参数（用于泛型递归 `Map<K,V>`）
- **`default`**：引用方未传该参数时使用

### 引用方传参

引用方在 `type.args` 里以 `{ <ParamName>: <TypeRef> }` 传实参：

```yaml
fields:
  - name: price_range
    type:
      ref: base.core.Range
      args: { T: decimal }
  - name: timestamp_range
    type:
      ref: base.core.Range
      args: { T: datetime }
# → price_range_low NUMERIC, price_range_high NUMERIC
# → timestamp_range_low TIMESTAMPTZ, timestamp_range_high TIMESTAMPTZ
```

投影器自动把 fields 里的 `T` 替换为实参类型。

> **类型参数与值参数共享 `type.args`**：`max_length`（值参数）和 `T`（类型参数）
> 都写在 args 里，加载器按"是否为声明的 type parameter 名"区分。
