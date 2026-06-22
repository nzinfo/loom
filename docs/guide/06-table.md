# table：表定义、扩展策略、枚举/索引/外键

`table` 承载物理结构 + 扩展策略。一个 table 文件描述一张物理表的列、主键、
索引、外键，以及如何承载自定义字段（extension strategy）。

## 基本结构

```yaml
# platform/base/core/users.table.yaml
version: loom-schema/v2
name: Users
table:
  name: users_base                      # 物理表名（不依赖推导）
  extension:
    strategy: sidecar_eav               # none | json_column | sidecar_eav
    ext_table: users_ext                # 可选，默认 <table_name>_ext
fields:
  - { name: id, type: bigint, required: true }
  - name: audit
    type: base.core.Audit
    column: ''              # flatten → created_at / updated_at
  - name: email
    type: base.core.Email
    required: true
    unique: true
primary_key: [id]
indexes:
  - name: idx_users_email
    fields: [email]
    unique: true
foreign_keys:                           # 可选
  - name: fk_user_roles_user
    fields: [user_id]
    ref_table: entity:base.core.User
    ref_fields: [id]
    on_delete: cascade
```

---

## 三种扩展策略

`table.table.extension.strategy` 决定如何承载自定义字段：

| strategy | 物理布局 | 适用场景 |
|---|---|---|---|
| `none` | 单表 `foo` | 审计、配置、关联表 | 否 |
| `json_column` | 单表 `foo`，加 `_ext JSONB` 列 | 简单少量自定义字段 | 否 |
| `sidecar_eav` | `foo_base` + `foo_ext`（view 在 entity 声明） | ERP 大量动态字段 |

### none（默认）

```yaml
table:
  name: user_roles
  extension:
    strategy: none
```

### json_column

```yaml
table:
  name: settings
  extension:
    strategy: json_column
```

投影会附加 `_ext JSONB` 列（MySQL 用 JSON，SQLite 用 TEXT）。

### sidecar_eav（推荐用于 ERP 场景）

```yaml
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
```

物理结构（JSONB 扩展组模型）：

```
┌─────────────────────┐         ┌──────────────────────────────────┐
│ users_base          │         │ users_ext                        │
│ (主表)              │ 1 ──── N │ (JSONB 扩展组表)                 │
├─────────────────────┤         ├──────────────────────────────────┤
│ id BIGINT PK        │ ◀────── │ base_id BIGINT  FK→users_base.id │
│ email               │         │ scope BIGINT NOT NULL             │
│ created_at          │         │ group_name VARCHAR(50) NOT NULL   │
│ ...                 │         │ values JSONB                      │
└─────────────────────┘         │ created_at TIMESTAMPTZ           │
                                └──────────────────────────────────┘
```

行的维度是 `(base_id, scope, group_name)`——三者组合唯一。两个正交的维度：

- **`group`**（编译期概念）：字段打包维度。一个 `.ext.yaml` 文件 = 一个 group。
  决定哪些字段打包进同一个 JSONB 文档。来自 `group:` 声明或文件 stem。
- **`scope`**（运行时概念）：数据归属维度。标识这行数据是谁的——每个 owner（platform /
  ext:provider / tenant:id）有自己的 scope hash 值。一个 base 记录的同一个 group 可能
  来自多个 scope（如 platform 全局数据 + tenant 专属数据各占一行）。

```
base_id=1, scope=hash(platform),     group_name='profile', values='{"nickname":"Alice"}'
base_id=1, scope=hash(tenant:acme),  group_name='profile', values='{"customer_no":"C001"}'
base_id=1, scope=hash(platform),     group_name='finance', values='{"credit_limit_amount":5000}'
base_id=1, scope=hash(ext:acme),     group_name='tax',      values='{"tax_id":"123"}'
```

scope 列只存 hash 值（由应用计算写入），loom 编译期不关心具体值。view 也不按 scope
过滤——可见性是查询阶段的事（应用加 `WHERE scope = ...`）。

> 策略名保留为 `sidecar_eav`（向下兼容），但物理模型已是 JSONB 扩展组，不再是旧的
> typed-column EAV。背景与权衡见
> [设计记录：JSONB 扩展组](../design/2026-06-22-jsonb-extension-groups.md)。

### view：在 entity 上声明

view 是 entity 的逻辑视图（base + ext 联合成 entity 视角的完整字段集），
所以在 **entity** 上声明，不在 table 上。省略则不创建 view。

```yaml
# user.entity.yaml
name: User
primary_table: table:base.core.Users
view: users                    # 可选；省略则不创建 view
```

### pivot view 的展开

```sql
CREATE VIEW users AS
SELECT
  u.id,
  u.created_at,
  u.updated_at,
  u.email,
  p.values->>'nickname' AS nickname,
  p.values->>'bio' AS bio,
  f.values->>'credit_limit_amount' AS credit_limit_amount
FROM base_core.users_base u
LEFT JOIN users_ext p ON p.base_id = u.id AND p.group_name = 'profile'
LEFT JOIN users_ext f ON f.base_id = u.id AND f.group_name = 'finance';
```

view 用 **LEFT JOIN**（每组一个，按 `group_name` 过滤）+ **JSON 提取**（`->>'key'`）
把组内的 JSON key 展开成虚拟列。**应用代码始终用 view 名（`users`）**，
不直接访问 `_base`/`_ext`。

多 owner 叠加的扩展字段（platform + ext + tenant）都会在 view 里展开成各自的
虚拟列——同组共享一个 JOIN，不同组各自 JOIN。详见 [08 extension_fields](./08-extension-fields.md)。

### 物理表名编码约定

- `none` / `json_column`：`foo`
- `sidecar_eav`：`foo_base`（主表）+ `foo_ext`（扩展表），view 暴露 `foo`

三种策略彼此正交；字段组复用走 struct 引用 + `column: ''`（详见 [05 字段复用](./05-mixin.md)）。

---

## variants：枚举的求和类型形态

v2 用类型论术语 **variants**（sum type）替代 v1 的工业惯用词 `enum`。variants 是
type 的 **form: enum**（与 `form: struct` 互斥）：

```yaml
# platform/base/core/user_status.type.yaml
version: loom-schema/v2
name: UserStatus
variants: [active, inactive, suspended]
# 或详写（带显示名/描述）：
variants:
  - value: active
    display_name: Active
  - value: inactive
  - value: suspended
```

- `fields` 与 `variants` 互斥（reader 校验）
- variants 元素支持双形式：字符串视为 `{ value: <str> }`；详写用 `value` 作为键
  （**不是** `name`——`value` 更贴切，对齐 sum type 的"分支值"概念）

引用处和其他 type 完全一样：

```yaml
fields:
  - name: status
    type: base.core.UserStatus         # 或经 using 短名：type: UserStatus
```

投影器按目标 type 节点的 form 分叉：enum form 的 variants 投成
单列（列标量报告为 `string`），值列表进入 enum registry 驱动方言生成。

> **v2 破坏性变更**：
>
> 1. v1 inline 写法（`base: enum, values: [...]`）取消，迁移到独立 type 节点（form: enum）
>    文件用 `variants:` 形态。
> 2. 求和类型现在由 type kind 的 `form: enum` 表达（详见 [03 type](./03-base-types.md)），
>    不再需要"假装是标量"。

物理投影：

| 方言 | DDL |
|---|---|
| PostgreSQL | `CREATE TYPE user_status AS ENUM ('active','inactive','suspended');` + 列类型引用 |
| MySQL | 列内联 `ENUM('active','inactive','suspended')` |
| SQLite | `TEXT` + `CHECK (value IN ('active','inactive','suspended'))` |

variants 严格说是 type（form: enum）的事，但因为通常在 table 字段里被引用，放在这里说明。

---

## 索引

```yaml
indexes:
  - name: idx_users_email
    fields: [email]
    unique: true
```

---

## 外键

```yaml
# platform/base/core/user_roles.table.yaml
fields:
  - { name: user_id, type: bigint, required: true }
  - { name: role_id, type: bigint, required: true }
primary_key: [user_id, role_id]
foreign_keys:
  - name: fk_user_roles_user
    fields: [user_id]
    ref_table: entity:base.core.User       # 身份引用，kind 前缀保留
    ref_fields: [id]
    on_delete: cascade
  - name: fk_user_roles_role
    fields: [role_id]
    ref_table: entity:base.core.Role       # 身份引用，kind 前缀保留
    ref_fields: [id]
    on_delete: restrict
```

> **v0.2.0 已知局限**：`ref_table` 当前原样渲染，`entity:` refs 不会自动解析为
> `primary_table` 的物理表名。建议先用 `table:` refs。

`ref_table` 是身份引用（带 kind 前缀），与字段 `type:` 的类型引用不同，详见
[09 refs](./09-refs.md)。

---

## 关键约束

- `table.name` 必须在所属 physical_schema 内唯一
- `primary_key` 字段必须都 `required: true`
- `decimal` 必须有 `precision` + `scale`
- 同 physical_schema 内表名唯一；跨 schema 可以重名
