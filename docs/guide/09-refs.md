# `$ref` 引用语法

loom 的跨文件引用是字符串（不是 map）。v2 把引用明确分成两个名字空间：
**类型引用**（无 kind 前缀）和**身份引用**（带 kind 前缀）。两者解析路径不同，
不可混用。

## 类型引用（field `type:`）

**形态**：三段名 `sys.mod.Name`，**不带** kind 前缀。

用于 field 的 `type:` 键，目标必须是 type 节点。

```
base.core.Email              ← base/core/email.type.yaml
base.core.Money              ← base/core/money.type.yaml
retail.pos.types.OrderId     ← retail/pos/types/order_id.type.yaml
```

逻辑名是 PascalCase（与推导规则一致）。

**解析路径**（详见 [04 类型引用](./04-type-refs.md) §using 短名解析规则）：

1. 单段短名（`Money`）→ 查当前文件 using 列表（默认含 `base.core.*`，scalar/struct/enum 统一解析）
2. 三段全限定（`base.core.Money`）→ 直接查节点表，验证 `kind === 'type'`
3. 全限定引用**不走 using**（已经全限定了）

**短名经 using**：

```yaml
using:
  - base.core.*
fields:
  - name: email
    type: Email                       # 短名，经 using 解析到 base.core.Email
```

**错误情况**：

- 短名歧义（多个 using 命名空间命中）→ `ambiguous type reference "X"`
- 目标 kind 不是 type →
  `type reference "X" resolves to kind=entity, expected type`
- 目标不存在 → `unknown type "X"`

## 身份引用（非类型）

**形态**：四段 `kind:sys.mod.Name`，**带** kind 前缀。

用于"这不是字段的类型，而是指向某个节点"的场景。kind 前缀必须与目标节点的
`kind` 字段匹配，加载器按身份表查找。

```
entity:base.core.User             ← base/core/user.entity.yaml
table:base.core.Users             ← base/core/users.table.yaml
mixin:base.core.Audit             ← base/core/audit.mixin.yaml
type:base.core.Email        ← base/core/email.type.yaml
```

**身份引用出现在哪些位置**：

| 位置 | 示例 | 说明 |
|---|---|---|
| `primary_table:` | `primary_table: table:base.core.Users` | entity 强引用一张 table |
| `ref_table:`（foreign_keys） | `ref_table: entity:base.core.User` | FK 引用目标表 |
| `- include:`（mixin） | `- include: mixin:base.core.Audit` | fields 数组里展开 mixin |
| `entity:`（extension_fields） | `entity: entity:base.core.User` | extension_fields 作用于哪个 entity |
| `exports:`（module_manifest） | `- type:base.core.Email` | 声明对外导出的节点 |

```yaml
fields:
  - name: id                           # field（类型引用走 type:）
    type: bigint
  - include: mixin:base.core.Audit     # 身份引用（mixin 展开到 fields）
```

## 为什么分两个名字空间

类型论上，"字段的类型"和"指向某个节点"是两件事：

- **类型引用**回答"这个字段是什么类型"——目标必须是 type（能投影成列），
  加载器验证 `kind === 'type'`。类型引用走更窄的名字空间（三段、无 kind），
  因为"是不是类型"由被引用节点自身的 `kind` 决定，不需要引用者再标。
- **身份引用**回答"我要指哪个节点"——目标可以是任意 kind（entity / table / mixin /
  type），kind 前缀让引用者和加载器都明确"我在找哪种节点"。
  `primary_table` 必须是 table，`include` 必须是 mixin，`entity:` 必须是 entity。

两套名字空间通过"被引用节点 `kind === 'type'`"这一条规则连接，互不冲突。
加载器内部维护两张查表：身份表（全 identity → node）、类型表（sys.mod.Name →
type node）。

## 跨 owner 引用是隐式的

身份引用和类型引用都**不带 owner 前缀**。owner 是节点属性，从路径推断；引用者
不需要也不应该指定 owner——加载器按全局名字空间查表。

这意味着 ext 包可以引用 platform 的 type：

```yaml
# ext/acme-corp/retail/pos/orders.table.yaml
fields:
  - name: total
    type: base.core.Money            # 引用 platform 的 type，不带 owner
```

详见 `docs/specs/2026-06-18-loom-v2-owner-dimension.md` §4。

## 悬挂 ref

`$ref` 目标不存在时报 `dangling_ref` 错误。kind 与上下文不符
（如 `ref_table` 指向 type）报 `kind_mismatch`。
类型引用的 kind 校验失败（目标非 type）报
`type reference "..." resolves to kind=..., expected type`。

错误类别速查见 [16 错误速查](./16-errors.md)。
