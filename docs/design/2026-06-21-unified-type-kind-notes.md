# 设计记录：统一 type kind（scalar / struct / enum）

- **日期**：2026-06-21
- **状态**：设计（未实现）
- **动机**：消除 base_types 这个"集合 kind"特例，让标量与值类型用同一个 kind `type` + 同一个扩展名 `.type.yaml` 表达。

## 1. 背景

当前 loom 有两个与"类型定义"相关的 kind，且形态不对称：

| | base_types | value_type |
|---|---|---|
| 文件数 | 全局**唯一** | 每个 `sys.mod.Name` 一个 |
| 内容 | 标量**集合**（`scalars:` 数组） | **单个**类型（`name` + `fields`/`variants`） |
| 位置 | 固定 `platform/base/core/` | 任意模块 |
| 身份 | `base_types:`（无 sys.mod） | `value_type:sys.mod.Name` |
| 解析角色 | **基底**（标量短名不走 using，全局可用） | **被解析**（短名经 using 解析） |
| 扩展名 | `.types.yaml`（短别名） | `.value_type.yaml`（全名） |

base_types 是整个系统**唯一的"集合 kind"**——一个文件装 N 个节点。其它所有 kind 都是"一文件一节点"。这个特例带来了一系列不对称：

- `.types.yaml` vs `.value_type.yaml` 两个 type 相关 token
- 标量与值类型走不同的解析路径（scalar registry vs valueType set）
- base_types 不进类型表（它是表的"基底"），身份无 sys.mod
- `value_type:` 身份前缀 vs `base_types:` 身份前缀（且 base_types 无 fqn）

## 2. 目标形态

**一个 kind `type` + `form` 三态**。每个标量拆成独立文件，与值类型文件结构对称。

### 2.1 文件布局（扁平）

```
platform/base/core/
  bigint.type.yaml       # form: scalar
  decimal.type.yaml      # form: scalar
  string.type.yaml       # form: scalar
  datetime.type.yaml     # form: scalar
  boolean.type.yaml      # form: scalar
  money.type.yaml        # form: struct
  email.type.yaml        # form: struct
  status.type.yaml       # form: enum
  range.type.yaml        # form: struct（带 type_parameters）
  audit.mixin.yaml       # 其它 kind 不受影响
  users.table.yaml
  user.entity.yaml
```

`bigint.type.yaml` 与 `money.type.yaml` 用同一个扩展名、同一个 kind——**类型定义的统一**。

### 2.2 标量形态（form: scalar）

```yaml
# decimal.type.yaml
version: loom-schema/v2
name: decimal
form: scalar
description: fixed-point
properties:
  - { name: precision, type: integer, required: true }
  - { name: scale,     type: integer, required: true }
```

```yaml
# bigint.type.yaml
version: loom-schema/v2
name: bigint
form: scalar
description: 64-bit integer
properties: []
```

**保留 properties**——它是 validate 校验"`type: {ref: decimal, args: {precision, scale}}` 必须提供 required 参数"的依据。去掉它会让参数校验失去编译期保障。properties 是 scalar form 的专属描述，与 struct form 的 fields、enum form 的 variants 结构对称。

> 命名约定：标量用**小写**名（`bigint`、`decimal`），struct/enum 用 **PascalCase**（`Money`、`Status`）。这是解析规则的一个判据（见 §4）。

### 2.3 struct 形态（form: struct）

```yaml
# money.type.yaml
version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type: decimal
    required: true
  - name: currency_code
    type: { ref: string, args: { max_length: 3 } }
    required: true
```

```yaml
# range.type.yaml —— 支持 type_parameters
version: loom-schema/v2
name: Range
form: struct
type_parameters:
  - { name: T, constraint: value, default: base.core.bigint, description: element type }
fields:
  - { name: low,  type: T }
  - { name: high, type: T }
```

### 2.4 enum 形态（form: enum）

```yaml
# status.type.yaml
version: loom-schema/v2
name: Status
form: enum
variants: [active, inactive, suspended]
```

### 2.5 base_types / value_type 不复存在

合并后 `FILE_KIND` 从 7 个降到 **6 个**：
`type` / `mixin` / `table` / `entity` / `extension_fields` / `module_manifest`。

## 3. Schema 设计

一个 `TypeSchema`，用 `form` 字段做 discriminated refinement：

```ts
const TypeSchema = z.object({
  version: versionSchema,
  name: z.string().min(1),
  form: z.enum(['scalar', 'struct', 'enum']),
  display_name: z.string().optional(),
  description: z.string().optional(),
  using: usingSchema,
  // form 专属字段（可选，superRefine 校验互斥）
  properties: z.array(scalarPropertySchema).optional(),       // scalar
  fields: z.array(fieldOrInclude).optional(),                 // struct
  variants: z.array(variantSchema).min(1).optional(),         // enum
  type_parameters: z.array(typeParameterSchema).optional(),   // struct only
  constraints: z.array(constraintSchema).optional(),          // struct only
}).strict().superRefine((data, ctx) => {
  // scalar: properties 允许，fields/variants/type_parameters 禁止
  // struct:  fields 允许（与 type_parameters 可组合），properties/variants 禁止
  // enum:    variants 必填且非空，properties/fields/type_parameters 禁止
});
```

`superRefine` 规则（form ↔ 专属字段的互斥矩阵）：

| 字段 | scalar | struct | enum |
|---|---|---|---|
| `properties` | ✓ | ✗ | ✗ |
| `fields` | ✗ | ✓（或 type_parameters only） | ✗ |
| `variants` | ✗ | ✗ | ✓ 必填 |
| `type_parameters` | ✗ | ✓ 可选 | ✗ |
| `constraints` | ✗ | ✓ 可选 | ✗ |

## 4. 解析规则变更

短名解析（typespace.ts）的判据从"kind"改为"form + 命名约定"：

1. **短名小写**（`decimal`、`bigint`）→ 查 `form: scalar` 类型（全局基底，**不走 using**）
2. **短名 PascalCase**（`Money`、`Status`）→ 经 using 查 `form: struct|enum` 类型
3. **三段全限定**（`base.core.Money`）→ 直接查 type 节点，校验 `form !== 'scalar'`（标量不允许三段引用——它们是基底，用短名即可）

**关键：标量仍是基底**。解析规则按 form 分叉，不按 kind 分叉。当前的 `ResolutionResult.scalar | value_type` 二分变成 `scalar | struct_or_enum`，语义不变，只是来源从"两个 kind 的 registry"变成"一个 type registry 里筛 form"。

### 4.1 link pass 的 registry 构建

当前（两个 registry）：
```ts
const scalars = collectScalars(parsed);      // from kind === 'base_types'
const valueTypes = collectValueTypeFqns(parsed);  // from kind === 'value_type'
```

统一后（一个 registry，按 form 切分）：
```ts
const typesByForm = collectTypes(parsed);    // from kind === 'type'
const scalars = typesByForm.scalar;          // form === 'scalar' short names
const valueTypes = typesByForm.struct_enum;  // form !== 'scalar' fqns
```

resolveShortName 的签名与逻辑不变，只是两个集合的来源换了。

## 5. 身份与 $ref 变更

### 5.1 身份前缀

`value_type:` 与 `base_types:` 统一为 `type:`：

```
# 之前
value_type:base.core.Email
value_type:base.core.Money
base_types:                        # 无 fqn

# 之后
type:base.core.Email
type:base.core.Money
type:base.core.bigint             # 标量也有身份了（form: scalar）
type:base.core.decimal
```

标量拆分后每个都有身份 `type:base.core.<name>`。base_types 的"集合身份 `base_types:`"消失。

### 5.2 $ref 语法

身份引用前缀统一：

```yaml
# 之前
- { include: mixin:base.core.Audit }
primary_table: table:base.core.Users
entity: entity:base.core.User
- { type: value_type:base.core.Email }   # exports 里

# 之后（type 类型的导出）
exports:
  - type:base.core.Email
  - type:base.core.Money
```

### 5.3 影响面（$ref / identity 出现处）

`type:` / `value_type:` 前缀在以下位置出现，需同步：
- `loader/link.ts`：`refValueTypeId = value_type:${ref}` → `type:${ref}`（行 202、373、445）
- `loader/link.ts`：`collectValueTypeFqns` → `collectTypes`（行 130-138）
- `projector/expand.ts`：`value_type:${ref}`（行 267）
- `projector/dialects/pg.ts`：`value_type:base.core.Status → ...`（行 131）
- `projector/types.ts`：注释中的 identity 示例
- `ir/refs.ts`：`REF_KINDS` 集合（从 FILE_KIND 派生，自动跟上）
- `ir/version.ts`：FILE_KIND、KIND_EXTENSIONS
- `ir/schemas.ts`：AnyFile 联合、SCHEMA_BY_KIND

## 6. 标量是否需要 identity？

**需要。** 拆分后标量是普通 type 节点，必须有身份才能进 nodes map、被 deps 图追踪、被 $ref 引用（exports、跨模块显式引用）。

`type:base.core.decimal` 这样的身份看起来"重"，但它表达了"decimal 是 base.core 模块定义的一个类型节点"这个事实——这是诚实的。当前 base_types 的"无身份集合"反而是特例。

> 注：标量的身份虽存在，但**字段引用标量用短名**（`type: decimal`），不写 `type:base.core.decimal`。解析规则 §4.1 已规定标量不走三段引用。身份主要用于 deps 图与 exports。

## 7. 迁移路径（破坏性，无外部用户）

### 步骤 1：schema 层
- `version.ts`：FILE_KIND 删 base_types/value_type，加 type；KIND_EXTENSIONS 改为 `.type.yaml`
- `schemas.ts`：新增 TypeSchema（form 判别 + superRefine），删 BaseTypesSchema/ValueTypeSchema；AnyFile/SCHEMA_BY_KIND 同步
- `paths.ts`：`.type.yaml` 通用；base_types 的精确路径特例**消失**（标量拆成普通 `*.type.yaml`，不再有 `base.types.yaml` 这个 singleton）

### 步骤 2：解析层
- `typespace.ts`：resolveShortName 内部不变；注释更新（来源从两 registry 变一 registry 筛 form）
- `link.ts`：collectScalars/collectValueTypeFqns → collectTypes（按 form 切分）；所有 `value_type:` → `type:`
- `refs.ts`：自动跟上（REF_KINDS 派生自 FILE_KIND）

### 步骤 3：投影层
- `expand.ts`：`value_type:${ref}` → `type:${ref}`
- `dialects/pg.ts`：identity 解析注释/逻辑更新
- `types.ts`：注释更新

### 步骤 4：fixture / 测试 / 文档
- fixture：`base.types.yaml` 拆成 N 个 `*.type.yaml`；`*.value_type.yaml` 改名 `*.type.yaml`；YAML 内容加 `form:` 字段
- 测试：所有 `value_type:` / `base_types:` identity 断言改为 `type:`
- 文档：guide/03（base_types）、guide/04（value_type）合并重写；specs 同步
- **golden 输出预期不变**（identity 不出现在 SQL 里，但需验证——标量拆分不改变投影的列定义）

### 步骤 5：命名约定文档化
- guide 里明确：scalar 用小写名、struct/enum 用 PascalCase；这是解析规则的判据之一

## 8. 代价与收益

### 收益
- **一个 kind `type`**：base_types/value_type 合并，消除唯一"集合 kind"特例
- **一个扩展名 `.type.yaml`**：`.types.yaml` / `.value_type.yaml` 双 token 消解
- **一条身份前缀 `type:`**：`value_type:` / `base_types:` 统一
- **一套解析规则**：按 form 分叉，而非按 kind 分叉
- **并发友好**：加标量 = 加文件，不碰其它标量文件
- **标量成为一等节点**：可被 deps 追踪、可被 exports 导出

### 代价
- base_types 1 文件 → N 个标量文件（~5-15 个小文件），文件数增加
- 标量文件需写 `form: scalar`（比 `scalars:` 数组项多一个 form 字段）
- 身份前缀变更（`value_type:` → `type:`）是破坏性，所有 fixture/测试/docs 同步
- 投影器/dialect 里硬编码的 `value_type:` identity 解析需逐处更新

### 风险
- **golden 漂移**：标量拆分理论上不改投影列定义，但需实测验证（万一 deps 图变化影响了排序/去重）
- **命名约定脆弱性**：scalar 小写 vs struct PascalCase 是约定，不是 schema 强制。若用户定义 `Money`（PascalCase）标量，解析会误判为 struct 候选。缓解：superRefine 可校验 scalar form 的 name 必须小写（`/^[a-z][a-z0-9_]*$/`），struct/enum 必须 PascalCase

## 9. 待决问题

1. **scalar name 强制小写校验**：是否在 schema 层加 `superRefine`（scalar name 匹配 `/^[a-z]/`）？倾向加——让命名约定成为编译期保障，而非软约定。
2. **enum variants 的 form**：当前 value_type 的 variants 形态是否就是 enum form？是。variants 字段从 value_type 专属变成 enum form 专属。
3. **type_parameters 是否 struct-only**：是。scalar/enum 不接受 type_parameters（superRefine 校验）。
4. **base.core 短名解析的基底性**：标量拆分后，`decimal` 短名仍应全局可用（不走 using）。collectTypes 构建 scalar set 时**收集所有 form:scalar 节点**（不限 base.core 模块）——还是只收集 base.core 的？倾向**只 base.core**（标量是系统基座，只由 platform 定义，ext/tenant 不定义标量——这与现状一致）。

## 10. 结论

方向已定：**统一到 type kind + form 三态**。这是一次中等规模的破坏性重构，但与一路"消除特例"的轨迹一致（_shared 移除 → 扩展名编码 kind → 现在 type kind 统一）。

实施前确认 §9 的四个待决问题，特别是 (1) scalar name 强制小写校验、(4) 标量基底性边界。确认后按 §7 步骤推进。
