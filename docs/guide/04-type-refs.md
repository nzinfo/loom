# 类型引用与 using 导入

字段如何引用类型、短名如何解析、`using:` 如何工作。类型本身的定义（scalar /
struct / enum 三态）见 [03 type](./03-base-types.md)。

## 单一 `type:` 键

任何 field 元素（table / mixin / struct / extension_fields 内）都只有一个类型键：

```yaml
fields:
  - name: age
    type: integer                     # 单段短名 → scalar 标量
  - name: email
    type: base.core.Email             # 三段全限定名 → struct/enum 类型节点
```

加载器按**点号数量**区分两种形态（详见 spec §3.2）：

| 形态 | 形式 | 含义 | 解析路径 |
|---|---|---|---|
| 短名 | `integer` / `Email`（无点） | 任意类型（scalar/struct/enum） | 查 using 命名空间（含默认 `base.core.*`） |
| 全限定 | `base.core.Email`（两个点） | 任意类型节点 | 直接查节点表，验证 `kind === 'type'` |

**为什么这么设计**：`integer`（内置标量）和 `base.core.Email`（用户定义的复合类型）
从类型论看是同类东西——都是"类型"，地位平等。"是不是类型"由被引用节点自身的 `kind`
决定，引用者只需说"我的类型是 X"，不需要再标 kind 前缀。scalar/struct/enum 的区分只
存在于**投影形态**（列怎么展开），不存在于**解析路径**——所有短名都走同一条 using 解析。

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
| `ref` | 类型引用（同简写字符串） | 单段=标量短名，三段=类型 fqn |
| `args` | 类型参数 | 所有标量参数都收拢在此，不再写 field 顶层 |
| `meta` | 元数据黑袋（`since`/`deprecated`/标签） | v2 不校验内容 |

简写 `type: integer` 在 link 阶段被规范化为 `{ ref: 'integer' }`，下游 pass 看到的
一律是对象。两种形式语义等价，但**带参数时必须用详写**（参数无处可放）。

**错误情况**：

- field 没有 `type:` → `field must have a type`
- `type: foo.bar.Baz` 节点不存在 → `unknown type "foo.bar.Baz"`
- `type: foo.bar.Baz` 目标 kind 不是 type →
  `type reference "foo.bar.Baz" resolves to kind=entity, expected type`
- `type: integer` 解析不到（不在任何 using 命名空间）→ `unknown type "integer"`
- 在 field 顶层写 `max_length`、`precision` 等参数键 → `Unrecognized key(s) in object`
  （v2 要求参数走 `type.args`）

---

## using 导入机制

v2 引入编程语言式的 `using:` 导入机制（类比 C# `using`、Java `import`、Go `import`），
让你用短名引用类型，不必每次写三段全限定名。

### 动机

`type: base.core.Email` 干净，但每次都写三段名仍然啰嗦。using 提供：

- **可读性**：`type: Money` 比 `type: base.core.Money` 干净
- **模块边界自文档化**：using 列表显式声明"这个文件依赖哪些模块的类型"
- **重构友好**：移动类型到另一模块，改 using 而非改所有引用处
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
    type: bigint                      # 默认导入的 scalar 短名
  - name: contact_email
    type: Email                       # 经 using 短名，等价 base.core.Email
  - name: total
    type: Money                       # 经 using 短名，等价 retail.pos.types.Money
```

using 列表为空时可省略 `using:` 键。

### 默认导入：`base.core.*`

每个文件**隐含** `using: [base.core.*]`，base.core 下的所有类型（scalar + struct/enum）
在任何文件里都可以直接用短名（`integer`、`string`、`Email`...），无需显式声明。

类比 Java 默认 `java.lang.*`、C# 默认 `System`、Go 的 builtins。

> 注意：scalar 与 struct/enum 走**同一条**短名解析路径——都查 using 命名空间。
> scalar 的"全局可用"是"base.core 是默认命名空间"的自然结果，不是 scalar 专属特权。
> ext 模块定义的 scalar 经 `using: [geo.core.*]` 同样可用。

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
2. **短名解析**（scalar/struct/enum 统一，不分流）：
   - 当前文件的 using 列表**总是隐含 `base.core.*`**（默认命名空间）
   - 遍历每条 using：若为 `<ns>.*` 则在 `<ns>.X` 处查类型节点；若为精确名则直接匹配
   - 收集所有命中的 fqn：
     - 唯一命中 → 解析为该 fqn
     - 多个不同 fqn 命中 → 报 `ambiguous type reference "X", candidates: ...`
     - 无命中 → 报 `unknown type "X"`
3. **全限定解析**：
   - 直接按 `sys.mod.declaredName` 查节点表
   - 验证目标节点 `kind === 'type'`，否则报
     `resolves to kind=..., expected type`
   - 不存在 → 报 `unknown type "sys.mod.declaredName"`
   - **全限定引用不走 using**（已经全限定了）

> link 把所有短名重写为 fqn 后写入字段，下游 pass（validate / expand）看到的都是 fqn。
> expand 按目标节点的 **form**（scalar/struct/enum）决定投影形态——不再按引用语法分叉。

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

