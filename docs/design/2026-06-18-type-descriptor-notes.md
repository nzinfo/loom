# 设计记录：Type Descriptor + variants + type_parameters

- **日期**：2026-06-18
- **作者**：nzinfo + Claude
- **关联**：`docs/specs/2026-06-18-loom-v2-type-system.md` §3.3 / §6 / §12
- **状态**：已落地（v0.2.0，commit `1f5c743` + `87a5bde`）

## 0. 背景

v2 第一版（commit `2fd9889` 之前）虽然把 `base`/`ref` 合并到了单一 `type:` 键，但
`type:` 本身仍是**裸字符串**——只约定了"它是一个类型名"，没有任何结构化描述能力。
所有标量参数（`max_length` / `precision` / `scale` / `pattern`）通过 Zod 的
`.catchall(z.unknown())` 散落在 field 顶层。

讨论时识别出的三个问题：

1. **类型是弱类型字符串**：无法携带 `since` / `deprecated` / 标签等元数据
2. **参数与字段约束混淆**：`max_length` 既是"字符串类型的实参"又是"字段约束"，
   语义暧昧
3. **无统一机制描述参数化类型**：将来想做 `Map<K,V>`、`Range<T>` 这种泛型，
   没有现成的承载点

档 B（Type Descriptor）是对这三个问题的统一回答。

## 1. 档 A / B / C 路线对比

讨论中考虑过三条路线：

### 档 A：保持裸字符串，参数留在 field 顶层

最小改动。`type: integer` 不变，`max_length` 仍在 field 顶层。

- 优点：改动最小，向后兼容
- 缺点：上面三个问题一个都没解决；泛型无承载点；元数据无处可放

### 档 B：Type Descriptor（详写对象 + 简写糖）✅ 选定

`type:` 双形式：
- 简写：`type: integer`、`type: base.core.Email`（向后兼容）
- 详写：`type: { ref, args, meta }`（结构化）

参数统一收拢到 `type.args`，元数据走 `type.meta`。简写在 link 阶段被规范化为详写，
下游 pass 只看到对象。

- 优点：双形式让简单场景保持简洁，复杂场景结构化；args 是泛型的天然承载点
- 缺点：reader 复杂度增加（union 解析 + 早期规范化），但收益覆盖成本

### 档 C：分键（`type:` + `args:` + `meta:` 都在 field 顶层）

把 args/meta 提到 field 顶层与 `type:` 平级。

- 优点：避免嵌套对象
- 缺点：参数和类型分离，读 `email.max_length` 要跨多个键拼合语义；args 与 type
  脱钩后，泛型实参（`T: decimal`）放哪又是个问题——回到档 A 的困境

**结论**：档 B 胜出。

## 2. enum → variants 的术语讨论

v1 用 `enum`（工业惯用词）表达"有限取值集合"，且语法上：
- 既可以 inline 在任意 field 处（`base: enum, values: [...]`）
- 又可以集中定义在 value_type 内部（`fields: [{name: value, base: enum, ...}]`）

讨论的两个问题：

### (a) 是否仅 enum 是 type.values 的使用方？

如果是，"type.values"这个名字太窄，应该改成更通用的。盘查发现：v1 里
`enum`+`values` 的组合确实**只有 enum 用**（其他标量都不带 `values` 列表）。结论：
"enum 是 values 的唯一用方"，所以命名应该围绕 enum 自身的设计来定，而非"为 values
找宿主"。

### (b) 是否应该用类型论术语 variants？

类型论里"有限取值集合"叫 **sum type** / **tagged union**，对偶于 record / product
type（v2 的 fields 形态）。如果 value_type 的两种形态分别叫：
- fields（product type）
- enum（工业词）

两者概念层次不对仗。改成：
- fields（product type）
- variants（sum type）

概念对仗整齐，且撕掉了 `enum` 与"标量+values 列表"的历史耦合。结论：**用 variants**。

### 变体元素的键：value 而非 name

简写形 `variants: [active]` 显然没有键名。详写形要给 display_name/description 留位置，
需要一个主键。讨论时倾向 `value`——对齐 sum type 的"分支值"语义；`name` 偏向
"标识符"含义，对一个枚举字面量来说不准确。

## 3. type_parameters 的 constraint 设计：type | value

声明形参时需要一个约束，限定**实参可以是啥**。讨论时考虑过：

| 候选 | 语义 | 问题 |
|---|---|---|
| `any` \| `concrete` | 任何类型 / 必须落地 | "any" 与 TypeScript 关键字撞名 |
| `type` \| `ref` | 类型 / 类型引用 | "ref" 在 loom 里已有特定含义（type descriptor.ref），混淆 |
| `type` \| `scalar` | 类型 / 标量 | "scalar" 太窄——实参也可以是 value_type fqn，不只是标量 |
| **`type` \| `value`** ✅ | 类型 / 值 | 对齐类型论：`type` 是 type-level、`value` 是 value-level |

`type` 表示实参可为任何类型（包括另一个 type parameter，用于泛型递归 `Map<K,V>`）；
`value` 表示实参必须是**具体落地类型**（标量短名或 value_type fqn）。

## 4. 与 CDS（SAP CAP）的对照

参考 `cds/docs/CDL-Reference.md`：

| 概念 | CDS | loom v2 |
|---|---|---|
| 内建类型 | `String(254)`、`Decimal(18,4)` | `type: {ref: string, args: {max_length: 254}}` |
| 自定义类型 | `type Email : String(254)` | `kind: value_type` + fields |
| 枚举 | `type Status : String enum { active; inactive; }` | `variants: [active, inactive]` |
| 泛型 | （CDS 内建少量泛型如 `Map<K,V>`、`Array<T>`） | `type_parameters` 声明 + 引用方 `args` 实例化 |

差异：
- CDS 用**函数式语法** `String(254)`，loom 用**对象 + args**（YAML 友好）
- CDS 枚举依附于 String scalar（`type X : String enum {...}`），loom 把 variants 提到
  value_type 顶层形态，概念更干净
- CDS 的泛型内建固定，loom 允许用户自定义 type_parameters

## 5. args 统一值参数与类型参数

关键决策：**值参数（`max_length`）与类型参数（`T`）共享同一个 `type.args` 通道**。

从类型论看：
- "字符串长度是 254"——值级别的实参化
- "Range 的元素类型是 decimal"——类型级别的实参化

两者本质都是"类型被实参化"的同一个动作，只是实参的 kind 不同（一个 value、一个
type）。统一到一个通道让 v2 的泛型机制可以平滑接入，无需第二套语法。discrimination
在解析时按"是否为声明的 type parameter 名"判断：

- `args: { max_length: 254 }` → `max_length` 不是声明的 type parameter → 值参数，
  交给标量属性校验
- `args: { T: decimal }` → `T` 是声明的 type parameter → 类型参数，交给
  `instantiateFields` 替换

## 6. 实现关键点

### 6.1 normalizeType 在 link 入口调用

```typescript
// loader/link.ts → resolveFieldTypes
const descriptor = normalizeType(rawType as string | TypeDescriptor);
(e as Record<string, unknown>).type = descriptor;  // 写回规范化对象
```

这是双形式的**单一规范化点**——所有下游 pass（validate / expand）只看到对象，不会
碰到裸字符串。如果绕过 link 直接读 schema 数据，会拿到原始形式。

### 6.2 variants 形态投影为单列

```typescript
// projector/expand.ts → expandField
if (variants && variants.length > 0) {
  return [{
    name: fName,
    scalar: 'string',    // 方言选字面类型用
    props: {},
    enumRef: targetId,   // registry key，驱动 PG ENUM / MySQL ENUM / SQLite CHECK
  }];
}
```

registry 结构（`Map<identity, string[]>`）不变，方言生成器**无需改动**——唯一调整是
从判断 `c.scalar === 'enum'` 改为只看 `c.enumRef`（因为 variants 列的 scalar 现在是
`string`）。

### 6.3 instantiateFields 是浅替换

```typescript
// projector/expand.ts → instantiateFields
for (const tp of typeParams) {
  const v = callerArgs[tp.name];
  if (typeof v === 'string') bindings.set(tp.name, v);
  else if (tp.default !== undefined) bindings.set(tp.name, tp.default);
}
// 对每个 field.type.ref === <ParamName> 的字段，把 ref 替换为 binding
```

v2 只支持绑定到裸类型名——args/meta 不透传。如果将来需要深替换（绑定到另一个
descriptor 并保留其 args/meta），可作为 v2.1 议题。

## 7. 测试覆盖

- `schemas.test.ts`：双形式解析、fields/variants 互斥、type_parameters 声明
- `link.test.ts`：normalizeType 后下游看到对象；type param 跳过解析
- `validate.test.ts`：required 参数走 type.args；type param 不被当 unknown scalar
- `projector-expand.test.ts`：variants 单列 + enumRef；Range<T> 实例化
- `projector-dialects.test.ts`：PG/MySQL/SQLite 都从 enumRef 触发枚举 DDL
- `golden.test.ts`：含 `Range<T>` 实例化（price_range_low/high）+ `Status` variants
  （base_core_status enum type）

## 8. 遗留 / 未来

- **type_parameters 深替换**：v2 浅替换；v2.1 可考虑透传 args/meta
- **meta 内容约束**：v2 是 `Record<string, unknown>` 黑袋；未来或收紧
  `since`/`deprecated` 的 schema
- **形态 C 重命名**：using 列表冲突消解仍未落地，临时用全限定名绕开
- **mixin using 化**：mixin 仍是 `include: mixin:...` 语法，v2.1 候选
