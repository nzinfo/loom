# loom v2：统一类型系统与 using 导入机制（设计）

- **状态**：设计讨论稿（待 review → 转 writing-plans）
- **日期**：2026-06-18
- **作者**：nzinfo + Claude
- **关联文档**：
  - `docs/specs/2026-06-17-loom-design.md`：v1 完整设计（本文档的对照基准）
  - `docs/superpowers/plans/2026-06-17-loom-v1.md`：v1 实现计划（已落地，v0.1.0）
- **格式版本**：本设计将 wire 格式从 `loom-schema/v1` bump 到 `loom-schema/v2`，
  **破坏性变更，不兼容 v1**

## 0. 摘要

v1 把字段的"类型"劈成两个互斥键 `base`（内置标量）与 `ref`（引用 value_type）。
从类型论看这是错的——两者都是"字段的类型"，应共享单一类型名字空间。v2 用单一
`type:` 键替代，并引入编程语言式的 `using` 导入机制支持短名引用。base_types 标量
获得与 value_type 平等的三段名身份，整个类型系统收敛为一个统一名字空间。

**一句话**：`base.core.Email` 自身就声明了"我是类型"（`kind: value_type`），
引用者只需写"我的类型是 Email"，不需要再标 `value_type:` 前缀。

## 1. 背景：v1 的语义错误

### 1.1 v1 现状

v1（spec §10）规定 value_type / table / mixin / extension_fields 的 field 元素
必须满足 `base` 与 `ref` 互斥：

```yaml
# v1
fields:
  - name: email
    ref: value_type:base.core.Email     # 自定义类型
  - name: age
    base: integer                       # 内置标量
```

加载器对 `base` 走标量查表，对 `ref` 走节点查找，分支在解析期就分明了。

### 1.2 为什么这是错的

从类型论看，`integer`（内置标量）和 `base.core.Email`（用户定义的 value_type）
**是同类东西**——都是"类型"。把它们用两个不同的键表达，等于人为把一个语义概念
劈成两半。

更深层的问题在于 `ref: value_type:base.core.Email` 这个写法本身：它把 **kind 标签**
（`value_type:`）粘到了**类型引用**上。但 kind 是被引用节点自身的事——Email 节点
的 `kind: value_type` 已经声明了"我是类型"，引用者只需说"我的类型是 Email"。

`kind:` 前缀真正属于**身份系统**（identity = `kind:sys.mod.Name`，用于 mixin include、
primary_table、ref_table 等**非类型**引用）。类型引用不该复用身份语法。

### 1.3 推论：单一类型名字空间

既然"是不是类型"由被引用节点自己说了算，类型引用就可以走一个**比身份更窄**的
名字空间：

- **身份**（identity）：`kind:sys.mod.Name`，四段，kind 必填，全局不唯一（同名的
  value_type 和 entity 可以并存）
- **类型引用**（type reference）：`sys.mod.Name`，三段，不带 kind；解析时加载器查
  节点表并验证目标 `kind === 'value_type'`，否则报错"X 不是类型"

这两套名字空间通过"被引用节点必须是 value_type"这一条规则连接，互不冲突。

## 2. 核心洞察

### 2.1 "Email 自身定义了它的类型是 type"

讨论中提出的关键论断：**`base.core.Email` 这个节点本身就是类型定义**——它的
`kind: value_type` 就是"我是一个类型"的声明。所以别处写 `type: base.core.Email`
时，不需要再加任何前缀。引用者只是说"我的类型是 Email"，是不是类型、是哪种类型，
由 Email 节点自己携带的 `kind` 决定。

### 2.2 base_types 标量与 value_type 地位平等

v1 里 base_types 标量是单段名（`integer`），value_type 是三段名
（`base.core.Email`），两者从语法形态上就不平等。

v2 让 base_types 也成为有身份的"模块"，其标量获得三段名 `base.core.<Scalar>`。
这样：

- `base.core.integer`（内置标量）
- `base.core.Email`（用户 value_type）

都是三段名、都是类型、地位完全平等。差异仅在来源（base_types 注册表 vs value_type
节点表），不在"是不是类型"。

## 3. 字段语法：单一 `type:` 键

### 3.1 新语法

所有 field 元素（value_type / table / mixin / extension_fields）统一用 `type:`：

```yaml
# v2
fields:
  - name: age
    type: integer                       # base_types 短名（默认导入）
  - name: email
    type: base.core.Email               # value_type 全限定名
  - name: balance
    type: base.core.Money
  - name: status
    type: base.core.UserStatus
```

### 3.2 `type:` 值的两种形态

加载器按**点号数量**区分，无需前缀：

| 形态 | 形式 | 含义 | 解析 |
|---|---|---|---|
| 短名 | `integer` / `string`（单段，无点） | base_types 标量 | 查 base_types 注册表 |
| 全限定 | `base.core.Email`（三段，两个点） | value_type 节点 | 查节点表，验证 `kind === 'value_type'` |

形态从语法上就分得开（点号数量不同），不需要 kind 前缀消歧。

### 3.3 Type Descriptor（详写形式）

`type:` 支持两种**书写**形式：简写（裸字符串）与详写（结构化对象）。简写经
`normalizeType` 在 link 阶段被规范化为详写，下游 pass（validate / expand）只看到对象。

```yaml
# 简写（向后兼容）
- name: email
  type: string

# 详写（携带 args / meta）
- name: email
  type:
    ref: string
    args: { max_length: 254 }
    meta: { since: v0.2.0 }
```

- **`ref`**：类型引用。单段（标量短名）或三段（value_type fqn）。语义同简写字符串。
- **`args`**：类型参数。统一承载两类参数：
  - **值参数**：标量属性（`max_length`、`precision`、`scale`、`pattern`）
  - **类型参数**：泛型实例化的实参（`T: decimal`，详见 §12）
  
  v1 里散落在 field 顶层的 `max_length` / `precision` / `scale` 等键**全部移除**，
  只接受 `type.args`。
- **`meta`**：`Record<string, unknown>` 黑袋。承载 `since` / `deprecated` / 标签等
  非语义元数据，v2 不校验其内容。

**为什么用 args 统一两类参数**：从类型论看，值参数（"字符串长度 254"）与类型参数
（"Range 的元素类型是 decimal"）都是"类型被实参化"的同一个动作——前者是值级别的
实参，后者是类型级别的实参。统一到一个通道让 v2 的泛型机制可以平滑接入而无需
引入第二套语法。

### 3.4 错误情况

- `type: base.core.Money` 但 `base.core.Money` 节点的 kind 是 entity（非 value_type）
  → 报错 `type reference "base.core.Money" resolves to kind=entity, expected value_type`
- `type: foo.bar.Baz` 但节点不存在
  → 报错 `unknown type "foo.bar.Baz"`
- `type: integer` 但 base_types 里没有 `integer`
  → 报错 `unknown scalar "integer"`
- field 没有 `type`
  → 报错 `field must have a type`

### 3.5 与 v1 的对照

| 场景 | v1 | v2 |
|---|---|---|
| 内置标量字段 | `base: integer` | `type: integer`（或详写 `type: {ref: integer}`） |
| 单字段 value_type 引用 | `ref: value_type:base.core.Email` | `type: base.core.Email` |
| 多字段 value_type 引用 | `ref: value_type:base.core.Money` | `type: base.core.Money` |
| 类型参数（max_length 等） | 散落 field 顶层 | `type.args: { max_length: 254 }` |
| 枚举 | inline `base: enum, values: [...]` 或 value_type | `variants:` 顶层形态（详见 §6） |
| field 缺类型 | 报 `must have either base or ref` | 报 `must have a type` |

## 4. using 导入机制

### 4.1 动机

`type: base.core.Email` 比 v1 的 `ref: value_type:base.core.Email` 干净，但每次
都写三段名仍然啰嗦。引入编程语言式的 `using`（类比 C# `using`、Java `import`、
Go `import`、TypeScript `import`）支持短名引用。

附带收益：

- **可读性**：`type: Money` 比 `type: base.core.Money` 干净
- **模块边界自文档化**：using 列表显式声明"这个文件依赖哪些模块的类型"
- **重构友好**：移动 value_type 到另一模块，改 using 而非改所有引用处
- **LSP / 补全友好**：using 列表给工具明确的补全范围

### 4.2 using 是文件级

每个 .yaml 文件顶部声明自己的 using 列表（类比 C# per-file `using`，而非 Go
package-level `import`）。模块内的不同文件可以有不同 using——更灵活，避免一个文件
引入整个模块不需要的依赖。

### 4.3 默认导入：`base.core.*`

每个文件隐含 `using: [base.core.*]`，base_types 标量在任何文件里都可以直接用
短名（`integer`、`string`、`decimal`、`enum`、`datetime`...）。

类比 Java 默认 `java.lang.*`、C# 默认 `System`、Go 的 builtins。

### 4.4 语法形态：A 与 B 统一

A（模块通配导入）和 B（精确导入）在语法上**统一为同一个机制**——都是"全限定路径
+ 可选通配后缀"：

```yaml
using:
  - base.core.*              # A：导入 base.core 命名空间下所有类型
  - retail.pos.types.*       # A：另一个模块全部
  - base.core.Email          # B：精确导入单个类型
  - base.core.Money          # B：另一个精确
```

末尾 `.*` = 命名空间通配；无 `.*` = 精确名。加载器按末尾是否 `.*` 分流，但词法
形态一致——这就是"A 与 B 统一"。

### 4.5 形态 C：重命名（挂起）

形态 C 用于命名冲突消解（两个模块都有 `Money`）。**语法待定**，需要在 A/B 落地后
专门设计。初步方向（仅讨论，未定稿）：

```yaml
# 方向 1：内联 map
using:
  - { from: base.core.Money, as: BaseMoney }
  - { from: retail.pos.types.Money, as: PosMoney }

# 方向 2：专用块
using:
  import:
    - base.core.*
    - retail.pos.types.*
  rename:
    base.core.Money: BaseMoney
    retail.pos.types.Money: PosMoney
```

**v2 不实现 C**。冲突的临时解决办法：用全限定名 `type: base.core.Money`（不走 using）。

### 4.6 名字解析规则

加载器看到 `type: X`，按以下顺序解析：

1. **形态分流**：单段（无点）走短名解析；三段（两个点）走全限定解析。
2. **短名解析**：
   - 先查 base_types 注册表（默认 `base.core.*` 导入）→ 命中即内置标量
   - 再查当前文件 using 列表：
     - 遍历每条 using，若为 `<ns>.*` 则在 `<ns>.X` 处查节点；若为精确名则直接匹配
   - 若短名在多个 using 命名空间命中 → 报 `ambiguous type reference "X", candidates: ...`
   - 若都没命中 → 报 `unknown type "X"`
3. **全限定解析**：
   - 直接按 `sys.mod.Name` 查节点表
   - 验证目标节点 `kind === 'value_type'`，否则报 `resolves to kind=..., expected value_type`
   - 不存在 → 报 `unknown type "sys.mod.Name"`
   - 全限定引用**不走 using**（已经全限定了）

### 4.7 using 的校验

- using 条目的命名空间或精确名必须存在 → 否则 `unknown using target "..."`
- 文件内 using 列表去重（同一条目重复写 → 警告或报错，待定）
- using 列表为空时可省略 `using:` 键

## 5. mixin：纳入 using（挂起）

v1 mixin 用独立语法 `- include: mixin:base._shared.Audit`。

讨论结论：**mixin 应同样走 using**。但 mixin 不是类型（不能被 `type:` 引用），它是
字段组插入——using 体系原本是类型名字空间，把 mixin 纳入需要单独设计。

**v2 不改 mixin 语法**，保留 v1 的 `- include: mixin:...`。mixin using 化留作
v2.1 候选议题，届时需要回答：

- mixin 的 using 形态（是否复用 `using:` 块？还是独立 `using_mixins:`？）
- mixin 短名 vs 全限定的解析
- mixin `include:` 语法是废弃还是与 using 共存
- mixin 命名空间与类型命名空间是否合并

本文档先不展开。

## 6. variants：value_type 的求和类型形态

### 6.1 v1 现状

v1 用工业惯用的 `enum` 表达"有限取值集合"，且语法上分散：

```yaml
# v1 inline（散落在任意 field 处）
fields:
  - name: status
    base: enum
    values: [active, inactive, suspended]

# v1 value_type（集中定义但语法重复）
fields:
  - name: value
    base: enum
    values: [active, inactive, suspended]
```

两个问题：
1. **inline enum 让"值列表放哪"暧昧**——同一组值可能在多处重复声明
2. **`enum` 是工业惯用词，不是类型论术语**——和值对象（record / product type）混在
   同一个 value_type 概念下时，缺一个明确的"它是 sum type"的标签

### 6.2 v2 决策：variants 作为 value_type 的顶层形态

v2 把 value_type 明确区分为**两种互斥形态**：

```yaml
# 形态 A：组合类型（值对象 / product type）
kind: value_type
name: Money
fields:
  - name: amount
    type: { ref: decimal, args: { precision: 18, scale: 4 } }
    required: true

# 形态 B：variants（求和类型 / sum type，取代 enum）
kind: value_type
name: UserStatus
variants: [active, inactive, suspended]
# 或详写：
variants:
  - value: active
    display_name: 活跃
  - value: inactive
```

- `fields` 与 `variants` 互斥（reader 校验：二者同时存在或同时缺失都报错）
- **`enum` 标量从 base_types 移除**——不再需要"假装是标量"，求和类型由 value_type
  顶层形态直接表达
- variants 元素支持双形式：
  - 简写：裸字符串 → 视为 `{ value: <str> }`
  - 详写：`{ value, display_name?, description? }`，键是 `value`（不是 `name`）

### 6.3 引用方

引用方与其他 value_type 完全一样——投影器自动检测目标 value_type 是 fields 形态
还是 variants 形态：

```yaml
fields:
  - name: status
    type: base.core.UserStatus       # 或经 using 短名 UserStatus
```

- variants 形态投影为**单列**，列的标量报告为 `string`（供方言生成器选用合适的字面类型）
- 枚举值列表进入 `model.enums` registry（identity → string[]），驱动 PG `CREATE TYPE
  AS ENUM` / MySQL `ENUM(...)` / SQLite `CHECK` 子句
- registry 结构不变，方言生成器**无需改动**

### 6.4 为什么用 `variants` 而不是 `enum`

类型论里，"有限取值集合"叫 **sum type** / **tagged union**，与 record / product type
（v2 的 fields 形态）对偶。`variants` 直接对应该术语，让 value_type 的两种形态在
概念上对仗整齐。`enum` 是 C/Java 借用的工业词，且历史上和"标量+values 列表"耦合，
含义偏窄；用 `variants` 撕掉这层历史包袱，统一在类型论词汇下描述。

### 6.5 收益

- "值列表放哪"不再暧昧，统一在 value_type 文件
- 概念对仗：value_type = fields（product） ∨ variants（sum）
- 复用性：同一组 variants 跨表引用无需复制
- 方言投影路径与其他 value_type 共用（registry 结构不变）

## 7. 身份系统的影响

### 7.1 身份不变

- value_type / entity / mixin / table 的身份仍为 `kind:sys.mod.Name`（四段，kind 必填）
- 用于 mixin include、primary_table、ref_table、entity 等**非类型**引用

### 7.2 类型引用是独立名字空间

- 类型引用走 `sys.mod.Name`（三段，无 kind）
- 与身份系统通过"被引用节点 `kind === 'value_type'`"连接
- 加载器维护**两个查表**：身份表（全 identity → node）、类型表（sys.mod.Name → value_type node）

### 7.3 base_types 的身份

base_types 文件自身身份 = `base_types:base.core`（kind=base_types，sys=base，mod=core）。
其下标量的"类型全限定名"= `base.core.<Scalar>`（如 `base.core.integer`）。

注意：标量本身**不是节点**（不在 IR 节点表里），它们是 base_types 节点 data 里的
数组项。类型表查询时，加载器先查 base_types 节点的 scalars 数组，再查 value_type
节点表。

## 8. version bump

- 新 wire 版本：`loom-schema/v2`
- reader 严格匹配，遇到 `loom-schema/v1` 报 `version` 错误
- v1 schema 文件**不兼容** v2 loader（loom 尚未发布，无线上数据，硬切最干净）
- `loom version` 输出的 `schema-versions-supported` 字段更新为 `loom-schema/v2`
  （v1 不在支持列表里）

## 9. 改动范围（实现预估）

按 v1 16 任务规模预估，v2 大致需要：

### 9.1 core 包

- **ir/version.ts**：`CURRENT_VERSION` → `loom-schema/v2`；`FORMAT_VERSION` 同步
- **ir/schemas.ts**：
  - 新增 `using` 字段到 ParsedFileBase（所有 kind 共享）
  - field schema 从 `base`/`ref` 互斥改为单一 `type:` 键
  - **Type Descriptor**（§3.3）：`type:` 接受 `z.union([z.string(), TypeDescriptorSchema])`
    双形式；移除 field 顶层散落的参数键（`.catchall(z.unknown())`），所有标量参数
    收拢到 `type.args`
  - **variants**（§6）：新增 `variantSchema` + `ValueTypeSchema.variants`，与
    `fields` 经 `.superRefine` 互斥校验；移除 base_types 里的 `enum` 标量
  - **type_parameters**（§12）：新增 `typeParameterSchema` + `ValueTypeSchema.type_parameters`
  - base_types 节点的 scalar 不变（仍是 data.scalars 数组）
- **ir/typespace.ts**：新增 `normalizeType` 把 string 简写规范化为 descriptor 对象
- **ir/refs.ts**：新增类型引用解析（`sys.mod.Name` 三段）；与身份 ref（四段）分离
- **loader/link.ts**：
  - 新增 using 解析（default `base.core.*` + 文件 using 列表）
  - 新增类型名字空间查表（base_types scalars + value_type nodes）
  - 短名歧义检测
  - 验证 `type:` 三段名目标 kind === 'value_type'
  - 入口 `normalizeType`：所有下游 pass 看到的 type 一律是对象
  - 识别 type_parameters：fields 里 `type: T` 若 T 是声明的 type parameter，跳过解析
- **loader/validate.ts**：
  - `checkScalarField` → `checkTypedField`（基于 `type.ref`）
  - required 参数检查改为查 `type.args`
  - value_type 若有 variants，跳过 fields 校验
  - type parameter 引用跳过 unknown-scalar 检查
- **projector/expand.ts**：
  - `expandField` 从 base/ref 分支改为单一 `type.ref` 分支
  - 参数来源改为 `type.args`（移除 `extractProperties`）
  - `collectEnums` → `collectVariants`：扫描 `variants` 顶层（而非 fields 里的
    `enum`+`values`），registry 结构不变
  - `instantiateFields`：generic value_type 引用方传 `args.T` 时实例化 fields
- **projector/types.ts**：`PhysicalColumn` 形态基本不变（仍是 name/scalar/props/...）
- **projector/dialects/**：方言生成器从 `c.scalar === 'enum'` 改为只看 `c.enumRef`
  （因为 variants 列的 scalar 现在报告为 `string`，但 enumRef 仍指向 registry 项）

### 9.2 cli 包

- `version.ts`：`FORMAT_VERSION` 引用更新（无需改逻辑）
- `check.ts` / `project.ts`：逻辑不变（透传 diagnostics）

### 9.3 测试与固件

- 所有测试固件（base_schema.ts 等）从 v1 语法改为 v2 语法
- 4 处标量参数迁移到 `type.args`：email.max_length、money.precision/scale、
  money.currency_code.max_length、user_fields.nickname.max_length
- 新增 `Range<T>` type_parameters 示例 + `Status` variants 示例
- 黄金固件 base_schema.pg.sql 重新生成（含 price_range_low/high + status enum）
- 新增 using 专项测试（短名、模块通配、精确、歧义、unknown target）
- 新增 variants 双形式 + fields/variants 互斥测试
- 新增 type_parameters 声明 + 实例化测试

### 9.4 文档

- 本 spec 文档（已在写）
- `docs/USER_GUIDE.md` 第 5/10/11 章重写（value_type / enum / ref → type + using）
- README 的 Status 段更新为 v2

## 12. type_parameters：参数化 value_type

### 12.1 动机

v2 之前，`Money` 这种值对象是写死的——amount 必是 decimal。但很多值对象本质是
**参数化**的：`Range` 的下界/上界可以是 int、decimal、datetime……element 类型应该
由引用方决定。这正是类型论里的 **parameterized type** / **generic**（`List<T>`、
`Map<K,V>`）。

v2 通过 `type_parameters` 把这一能力引入 value_type，让一个 value_type 定义服务
多种实例化。

### 12.2 声明

```yaml
kind: value_type
name: Range
type_parameters:
  - name: T
    constraint: value              # type | value
    default: base.core.bigint
    description: 元素类型
fields:
  - name: low
    type: T                        # 引用 type parameter
  - name: high
    type: T
```

- **`name`**：参数标识符。在 value_type 的 fields 里被 `type: <name>` 引用
- **`constraint`**：
  - `type`（默认）：实参可为任何类型，**包括另一个 type parameter**——用于泛型递归
    （如 `Map<K,V>` 里 K、V 可再绑定到上层 generic 的参数）
  - `value`：实参必须是**具体类型**（标量短名或 value_type fqn），不接受 type
    parameter 名——用于"这个位置必须是落地类型"的约束
- **`default`**：可选。引用方未传该参数时使用（必须是具体类型 fqn 或短名）
- **`description`**：人类可读说明

### 12.3 引用方传参

引用方在 `type.args` 里以 `{ <ParamName>: <TypeRef> }` 形式传实参：

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
```

实参（`decimal` / `datetime`）经过与字段 type 同样的解析路径（单段→标量，三段→
value_type fqn）。注意：**类型参数与值参数共享 `type.args` 通道**——`max_length`
（值参数）和 `T`（类型参数）都在 args 里，discrimination 在解析时按"是否为声明的
type parameter 名"判断。

### 12.4 实例化

投影器在 `expandField` 阶段做替换：

1. 读目标 value_type 的 `type_parameters` 声明
2. 读引用方 `type.args` 里对应的绑定（缺失则用 `default`；都没则保留参数名——
   投影会失败并报错）
3. 遍历 fields，对每个 `type.ref === <ParamName>` 的字段，把 ref 替换为绑定的类型
4. 投影替换后的 fields

替换是**浅替换**——args/meta 不透传（v2 只支持绑定到裸类型名）。

### 12.5 与 type descriptor 的协同

type_parameters 与 §3.3 type descriptor 是同一套机制的延伸：

- 字段 type 的 `args` 通道统一承载值参数（`max_length`）与类型参数（`T`）
- 简写 `type: T` 与详写 `type: { ref: T }` 等价
- 引用方传 `args: { T: decimal }` 时，args 既被 generic 实例化消费（`T` 被绑定），
  也可能被标量属性消费（`max_length` 被读取）——视目标 value_type 的形态而定

这就是 §3.3 选 args 而非另起一个键的原因：值参数与类型参数本是同一抽象的两种实例。

## 10. 未决 / 挂起项

| 项 | 状态 | 备注 |
|---|---|---|
| 形态 C（重命名）语法 | 挂起 | A/B 落地后专门讨论；v2 临时用全限定名绕开冲突 |
| mixin using 化 | 挂起 | v2.1 候选；mixin 不是类型，纳入 using 需独立设计 |
| using 列表去重的校验严格度 | 待定 | 警告 or 报错 |
| 短名歧义错误的候选列表格式 | 待定 | 排序、是否含 kind |
| type_parameters 深替换 | 待定 | v2 仅浅替换（绑定到裸类型名）；若需透传 args/meta 留作 v2.1 |
| `meta` 内容约束 | 待定 | v2 是 `Record<string, unknown>` 黑袋；未来或收紧 `since`/`deprecated` schema |

## 11. 与 v1 spec 的差异速查

| 维度 | v1（2026-06-17） | v2（本文档） |
|---|---|---|
| 字段类型键 | `base` / `ref` 互斥 | 单一 `type:`（简写或详写 descriptor，§3.3） |
| 类型引用语法 | `value_type:base.core.Email`（带 kind） | `base.core.Email`（无 kind） |
| 内置标量名 | 单段 `integer` | 短名 `integer` 或全限定 `base.core.integer` |
| 类型名字空间 | 复用身份空间（带 kind） | 独立三段名空间 |
| 标量参数位置 | 散落 field 顶层（`max_length`、`precision`...） | 统一收拢到 `type.args`（§3.3） |
| 导入机制 | 无 | `using:` 文件级，默认 `base.core.*` |
| 枚举表达 | inline `base: enum` 或 value_type 内部 | value_type 顶层 `variants:` 形态（§6） |
| 参数化类型 | 不支持 | `type_parameters` + 引用方 `args.T`（§12） |
| wire 版本 | `loom-schema/v1` | `loom-schema/v2` |
| mixin include 语法 | `- include: mixin:...` | 不变（v2.1 候选改造） |

---

**下一步**：本文档 review 通过后，转 writing-plans 拆解为 v2 实现计划，
再按 subagent-driven-development 执行。
