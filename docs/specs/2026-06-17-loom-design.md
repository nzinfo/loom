# loom：正向 Schema 描述语言设计

- **状态**：设计完成（spec self-review 通过）；骨架已初始化，待 writing-plans
- **日期**：2026-06-17
- **作者**：nzinfo + Claude
- **项目名 / CLI**：`loom`（独立 TypeScript 仓库，Node.js 运行时）
- **格式家族**：`loom-schema/v1`（写在 schema 文件的 `version:` 行）
- **关联文档**：
  - `docs/yaml-spec/`：`atlas-yaml/v2` 物理 schema YAML 规范（逆向产物）
  - `docs/yaml-serialization/design.md`：逆向 YAML 序列化的设计与实现计划

## 命名说明

- **工具名 `loom`**（织布机）：design schema 是图样（pattern），投影器是织机，
  物理 schema 是织成的布。与 atlas（地图集）构成"地图与织机"的含蓄对偶——
  atlas 描述已有的物理世界，loom 从设计意图织出物理实现。
- **格式家族 `loom-schema`**：区别于 `atlas-yaml`（物理事实）和其他通用
  schema 格式。`v1` 是 wire 版本号，破坏性变更必须 bump。
- **CLI 命令前缀**：`loom check`、`loom fmt`、`loom project`、`loom lift`。

## 1. 背景与目标

### 1.1 背景

`atlas-yaml/v2` 已实现：从现有数据库**逆向**出物理 schema，导出为 diff-stable
YAML，服务 DBA 归档、GitOps、Code Review 等场景。该格式：

- 是**物理事实**的描述（数据库实际有什么）
- 强调字节级 diff-stability
- 明确不在范围内：DDL 生成、业务语义、API、代码生成

现在需要的是**正向**的 schema 描述语言，服务于软件**正向开发**流程：
UI 可视化建模、LLM 生成、Prisma schema 导入都是它的生产者，物理 DDL
是它的下游产物之一。

### 1.2 核心定位

> **YAML 作为 AST/IR 实际的知识表示的事实**——不排斥 DSL / UI 等上层
> 生产者，但 YAML 是权威真理源。

### 1.3 与 atlas-yaml/v2 的关系

**两层独立格式 + 单向投影**：

```
                  ┌───────────────────────────┐
   UI / LLM /     │  loom-schema/v1 (design)    │
   Prisma import ─▶│  - entity / value_type   │
                  │  - 业务身份、扩展策略      │
                  └────────────┬──────────────┘
                               │ 投影器（design → physical）
                               ▼
                  ┌───────────────────────────┐
                  │ atlas-yaml/v2 (physical)  │
                  │  - tables / columns       │
                  │  - 方言属性                │
                  └────────────┬──────────────┘
                               │ migrate 包
                               ▼
                            DDL / SQL
```

- **正向**：loom → atlas-yaml/v2 → DDL（自动化、可重放）
- **反向**：atlas-yaml/v2 → loom-schema **不可逆**（物理事实不含业务身份、权限、
  扩展策略等语义）。反向需要人工或 LLM **提炼**，结果作为新 loom schema 文件
  存档。
- **两种格式互不依赖**：loom 可以脱离 atlas-yaml/v2 单独存在
  （例如直接生成 DDL，绕过中间的物理 YAML）；atlas-yaml/v2 也继续独立
  服务 DBA 场景。

## 2. 关键设计决策（已确认）

| # | 维度 | 决策 | 备注 |
|---|---|---|---|
| 1 | 与 atlas-yaml/v2 关系 | 两层独立格式 + 单向投影 | 反向需人工/LLM 提炼 |
| 2 | 扩展机制 | Sidecar EAV 扩展表 | 主表结构永不因自定义字段改变；与 SAP/Oracle ERP 主流做法一致 |
| 3 | 文件组织 | `system / module / {value_type \| table \| entity}` + 全局 `base_types.yaml` | |
| 4 | value type 能力 | 可映射到多个物理列；支持 newtype 模式 | 解决 Money（金额+币种）、Address（多字段）等痛点 |
| 5 | 版本策略 | 只管格式版本；内容变更走 git | 与 atlas-yaml/v2 一致 |
| 6 | 本次 spec 范围 | entity + value type 层 | 对接上层业务建模；API 权限/代码生成是后续 spec |
| 7 | 架构方案 | 方案 A：YAML-as-AST，无独立 Go IR | 投影器是工具，产出是衍生品 |
| 8 | diff-stability 契约 | 手工编辑后须提供 reformat 工具，保证稳定排序可 diff | 与 atlas-yaml/v2 一致 |

## 3. Section 1：格式版本与文件头

### 3.1 格式版本

```yaml
version: loom-schema/v1
```

- `loom-schema`：格式家族（区别于 `atlas-yaml` 物理 YAML）
- `v1`：当前版本
- reader 严格匹配；wire 格式变更必须 bump 版本号
- 每个文件顶格第一个 key 必须是 `version`

### 3.2 路径即身份（无冗余 header）

**身份信息（system / module / kind / name）从文件路径推导，不写在文件头**：

```
systems/base/core/entity/user.yaml
└system─┘ └module┘ └kind┘ └name┘
=> identity = entity:base.core.User
```

文件头只有两行：

```yaml
version: loom-schema/v1
kind: <entity | table | value_type | module_manifest | base_types>
# 后面直接是该 kind 的内容
```

### 3.3 路径布局

```
base_types.yaml                                     ← 全局唯一，kind: base_types
systems/
  base/                                             ← system = base
    core/                                           ← module = core
      MANIFEST.yaml                                 ← kind: module_manifest
      value_type/
        email.yaml
        money.yaml
      table/
        audit_log.yaml
      entity/
        user.yaml
        role.yaml
  retail/
    pos/
      value_type/...
      table/...
      entity/...
```

### 3.4 命名约定

- **目录/文件名**：kebab-case（`user-profile.yaml`）
- **路径推导的逻辑名**：转 PascalCase（`user` → `User`，`user-profile` → `UserProfile`）
- **数据库物理名**：在 entity / table 内部的 `table.name` 字段显式声明
  （默认 snake_case 复数；如 `user` entity → `users` 表）

### 3.5 `$ref` 语法

跨文件引用（载荷字符串）：

```
value_type:base.core.Email          ← 引用 base/core/value_type/email.yaml
entity:retail.pos.Order             ← 引用 retail/pos/entity/order.yaml
table:base.core.audit_log           ← 引用 base/core/table/audit-log.yaml
```

- 与 atlas-yaml/v2 的 `$ref` 风格一致（基于路径的稳定 ID）
- 同文件内引用支持 short form（`value_type:.Money`，省略 system.module），
  加载器按当前文件上下文补全
- 反序列化两阶段：Pass 1 建对象，Pass 2 解 `$ref`；悬挂 ref 报
  `dangling $ref "..." (no node with that id)`

### 3.6 加载期校验

加载器在 init 阶段断言：

- 路径推导出的 identity 与文件内任何自指（如有）一致
- 同一 identity 全局唯一
- `$ref` 目标必须存在；否则 `dangling $ref` 错误
- 文件物理路径与逻辑 identity 必须一一对应（不允许符号链接绕过）

### 3.7 系统组装（部署期，本次 spec 不展开）

`system:` 概念已经为部署组装留位——同一 entity schema 在 `system: base`
下声明，部署时由更上层的"系统组装 spec"决定哪些 system 进入一个产品
（基础系统 / 零售扩展 / 连续制造扩展 / ...）。这部分不在本 spec 范围。

## 4. Section 2：base_types 全局类型目录

`base_types.yaml` 是**可用的字段类型注册表**——所有 value type / table
field / entity field 最终都要落到这些基础类型之一。它决定整个系统的
"原子词汇表"。

### 4.1 设计取向：纯逻辑类型目录（不带方言）

base_types 只列**逻辑类型名 + 抽象属性**（如 `decimal` 有
`precision/scale`，`string` 有 `max_length`），**不绑定具体方言**。
方言投影在投影器里集中管理（`decimal` → PG `NUMERIC(18,4)` / MySQL
`DECIMAL(18,4)` / SQLite `TEXT`）。

理由：

- value type 表达**业务意图**（金额是 decimal），不是物理事实
- 与"design schema 单向投影到物理"哲学一致
- 投影器集中管理"逻辑类型 × 方言"矩阵（一份代码，全局生效）
- 与 Prisma scalar 类型哲学一致

### 4.2 base_types.yaml 草案

```yaml
version: loom-schema/v1
kind: base_types

# 标量类型目录。每条声明：逻辑类型名 + 抽象属性 schema + 默认值。
scalars:
  - name: boolean
    description: 布尔值
    properties: []

  - name: integer
    description: 整数
    properties:
      - name: min
        type: integer
      - name: max
        type: integer

  - name: bigint
    description: 64位整数
    properties: []

  - name: decimal
    description: 定点小数（金额、计量等）
    properties:
      - name: precision
        type: integer
        required: true
      - name: scale
        type: integer
        required: true
      - name: min
        type: decimal
      - name: max
        type: decimal

  - name: string
    description: 变长字符串
    properties:
      - name: max_length
        type: integer
        required: true
      - name: pattern
        type: string                   # 正则
      - name: charset
        type: string                   # utf8 / ascii

  - name: text
    description: 长文本（无长度上限）
    properties: []

  - name: datetime
    description: 时间戳（带时区）
    properties:
      - name: precision
        type: integer                  # 秒/毫秒/微秒
      - name: tz
        type: string                   # UTC / local

  - name: date
    description: 日期（不含时间）
    properties: []

  - name: uuid
    description: UUID
    properties:
      - name: version
        type: integer                  # 4 / 7

  - name: bytes
    description: 二进制
    properties:
      - name: max_length
        type: integer

  - name: json
    description: 结构化 JSON
    properties: []

  - name: enum
    description: 枚举（值列表在 value_type 定义，见 §11）
    properties:
      - name: values
        type: array<string>
        required: true
```

### 4.3 关键约束

- **base_types.yaml 是唯一权威**。value type / table field 引用的 scalar
  必须在此声明，否则 `unknown scalar type` 错误
- **v1 内不可扩展**。用户想加新 scalar，需改 base_types.yaml + 投影器，
  bump 版本号。封闭词汇表便于 LLM/UI 提供补全
- **不出现方言**。base_types 不写 `pg: NUMERIC`，由投影器决定
- **属性有类型**。属性自身用 base_type（递归闭包），保证属性可校验

### 4.4 不在 base_types 里的东西

- **复杂业务类型**（Money、Address、Email）→ 它们是 **value type**，由用户
  在 `value_type/` 目录定义，引用 base_types 的 scalar
- **数组/集合**（`string[]`）→ 在 field 上用 `array: true` 表达，不是 scalar
- **lookup / 外键** → 是 entity field 的语义，用
  `type: { kind: ref, ref: entity:... }` 表达，不是 scalar

## 5. Section 3：value_type

value_type 是用户定义的"语义类型"，介于 base_type scalar 和 entity field 之间。
它解决两个核心问题：

1. **newtype 语义包装**：给一个 scalar 加上语义标签
   （`Email = string` + 正则 + 长度），避免把 `user_email` 和
   `invoice_email` 当成同一种 string 混用
2. **多字段映射**：一个业务概念需要多个物理列才能完整表达
   （Money = amount + currency；Address = street + city + zip；
   DateRange = start + end）

### 5.1 风格：编程语言类型定义

value_type 采用**编程语言类型定义**风格——文件本身就是 type 定义，
不需要 `type:` 包裹；用 `fields`（逻辑视角）而非 `columns`（物理视角）；
字段属性平铺，不再嵌套 `properties:`。

类比：

| 编程语言 | value_type |
|---|---|
| TypeScript `type Email = string & { ... }` | `fields: [{name: value, base: string, ...}]` |
| Rust `struct Money { amount: Decimal, currency: Currency }` | `fields: [{name: amount, ...}, {name: currency_code, ...}]` |
| Go `type Money struct { Amount decimal.Decimal; Currency string }` | 同上 |

### 5.2 单字段 value_type（newtype 语义）

```yaml
# systems/base/core/value_type/email.yaml
version: loom-schema/v1
kind: value_type
name: Email
display_name: 电子邮箱
description: RFC 5322 邮箱地址
fields:
  - name: value                        # 单字段约定用 "value"
    base: string
    max_length: 254
    pattern: '^[^@]+@[^@]+\.[^@]+$'
constraints:
  - kind: check
    expr: "value IS NULL OR value LIKE '%@%'"
```

### 5.3 多字段 value_type

```yaml
# systems/base/core/value_type/money.yaml
version: loom-schema/v1
kind: value_type
name: Money
display_name: 金额
description: 带币种的金额
fields:
  - name: amount
    base: decimal
    precision: 18
    scale: 4
    required: true
  - name: currency_code
    base: string
    max_length: 3
    required: true
    default: CNY
constraints:
  - kind: check
    expr: "amount >= 0"
  - kind: check
    expr: "currency_code IN ('CNY', 'USD', 'EUR')"
```

### 5.4 属性平铺规则

字段属性直接写在字段上（`max_length: 254`），不再嵌套 `properties:`。
加载器根据 `base` 查 base_types 里 scalar 声明的 properties schema 做校验：

- `string` scalar 接受 `max_length / pattern / charset`，写了不存在的属性报错
- `decimal` scalar 接受 `precision / scale / min / max`
- 其他 scalar 类推

### 5.5 物理投影规则（前缀消歧）

当 entity field 引用 value_type 时，物理投影按 value_type 字段数决定：

- **单字段且 `name: value`** → entity 字段名直接作为列名，**不加后缀**
  - `email: Email` → 列 `email VARCHAR(254)`
  - 这样单字段 newtype 的物理层与直接用 scalar 无区别，
    但语义校验/补全仍按 `Email` 类型来
- **多字段** → entity 字段名作前缀 + value_type 字段名
  - `balance: Money` → 列 `balance_amount DECIMAL(18,4)` +
    `balance_currency_code VARCHAR(3)`
  - 多个 Money 字段（`balance`、`total_price`、`tax`）在同一表里不冲突

### 5.6 约束（constraints）

`constraints` 是逻辑表达式，投影器根据目标方言决定落地：

- PG / MySQL 8+ / SQLite：落到 `CHECK (...)`
- 不支持的方言：投影器报错或降级为应用层校验

表达式语法使用 SQL 子集（与 atlas-yaml/v2 的 RawExpr 一致），
字段名直接引用 value_type 内的 field name。

### 5.7 不允许的东西

- **value_type 嵌套**：多字段 value_type 的 field 不能引用另一个多字段
  value_type（避免无限展开）。field 可以引用单字段 value_type（单列可嵌套）
- **递归**：value_type 不能引用自己（直接或间接）
- **隐式字段**：fields 必须显式列出所有字段

### 5.8 校验

- field 的 `base` 必须是 base_types 里的 scalar（或单字段 value_type 的 ref）
- field 上的属性必须匹配 scalar 在 base_types 里声明的 properties schema
- name 全局唯一（包括跨 system/module）
- constraints 表达式里的字段名必须出现在 fields 中

## 6. Section 4：table 与 module_manifest

### 6.1 table 与 entity 的关系

`entity = table + [可选业务身份包装]`。table 承载**物理结构 + 扩展策略**；
entity 在 table 之上加业务身份（display_name、description、后续的权限/API）。

**table 是扩展策略的载体**（之前一度错放在 entity 层）。三种扩展策略：
`none` / `json_column` / `sidecar_eav`。通过物理表名编码策略，view 屏蔽
编码细节，应用代码始终访问稳定 view 名。

### 6.2 module_manifest 承载 physical_schema

**物理 schema 空间分配（PG schema / MySQL database）属于 module 级别决策**，
不应该 per-table 配置。它由 `MANIFEST.yaml` 决定，加载器加载 table 时
自动从所属 module 的 MANIFEST 补全完整物理位置。

```yaml
# systems/base/core/MANIFEST.yaml
version: loom-schema/v1
kind: module_manifest
system: base                            # 可从路径推导，显式更清晰
module: core
physical_schema: base_core              # 整个 module 的物理 schema 空间
description: 基础核心模块（用户、角色、权限）

# 可选：本 module 暴露给其他 module 的导出
exports:
  - entity:base.core.User
  - entity:base.core.Role
  - value_type:base.core.Email
```

**好处**：

- 模块迁移（重命名 physical_schema）只改一处
- table 文件聚焦于"这张表长什么样"
- module 级别的部署配置（哪个库、哪个 schema）集中管理
- 与 ERP 的"模块化部署"哲学一致

### 6.3 table 文件示例（sidecar_eav 扩展）

```yaml
# systems/base/core/table/users.yaml
version: loom-schema/v1
kind: table
name: Users
display_name: 用户
description: 系统用户主表
table:
  name: users_base                      # 物理表名（仅 name，无 schema）
  extension:
    strategy: sidecar_eav               # none | json_column | sidecar_eav
    ext_table: users_ext                # strategy=sidecar_eav 时必填
    view: users                         # 暴露给应用的稳定 view 名
fields:
  - name: id
    base: bigint
    required: true
  - name: email
    ref: value_type:base.core.Email     # 引用 value_type，单字段不加后缀
    required: true
    unique: true
  - name: created_at
    base: datetime
    required: true
primary_key: [id]
indexes:
  - name: idx_users_email
    fields: [email]
    unique: true
```

加载器加载后：物理位置 = `base_core.users_base`（MANIFEST 的
physical_schema + table.name）。

### 6.4 扩展策略的三种值

| strategy | 物理布局 | 适用场景 | view 是否必填 |
|---|---|---|---|
| `none` | 单表 `foo` | 审计、配置、关联表 | 否（view=表名） |
| `json_column` | 单表 `foo`，加 `_ext JSONB` 列 | 简单少量自定义字段 | 否（view=表名） |
| `sidecar_eav` | `foo_base` + `foo_ext` + view `foo` | ERP 大量动态字段 | 是（必须 view） |

### 6.5 物理表名编码约定

- `none` / `json_column`：`foo`
- `sidecar_eav`：`foo_base`（主表）+ `foo_ext`（扩展表），view 暴露 `foo`

应用代码始终用 view 名（`foo`），不直接访问 `_base`/`_ext`。投影器在生成
ORM 类型/代码时也按 view 名生成。

### 6.6 view 的自动生成

投影器在 `strategy != none` 时自动生成 view 定义：

- `json_column`：view 等于表本身
  （`CREATE VIEW foo AS SELECT * FROM foo`）—— 为对称性
- `sidecar_eav`：view 把 `_base` 和 `_ext` 通过 join/子查询合并成
  "宽表"形态（具体形态在 Section 5 自定义字段数据模型展开）

### 6.7 table 字段风格

与 value_type **完全一致**：

- `fields` + 平铺属性 + 同样的 base 引用规则
- field 可以用 `base`（scalar）或 `ref`（value_type）二选一
- 单字段 value_type 引用 → entity/table 字段名直接作为列名
- 多字段 value_type 引用 → entity/table 字段名作前缀 + value_type 字段名

学习曲线低、reformat 工具一套代码搞定。

### 6.8 多对多关联表示例

```yaml
# systems/base/core/table/user_roles.yaml
version: loom-schema/v1
kind: table
name: UserRoles
display_name: 用户角色关联
table:
  name: user_roles
  extension:
    strategy: none
fields:
  - name: user_id
    base: bigint
    required: true
  - name: role_id
    base: bigint
    required: true
  - name: granted_at
    base: datetime
    required: true
primary_key: [user_id, role_id]
foreign_keys:
  - name: fk_user_roles_user
    fields: [user_id]
    ref_table: entity:base.core.User        # 也可用 table:base.core.users_base
    ref_fields: [id]
    on_delete: cascade
  - name: fk_user_roles_role
    fields: [role_id]
    ref_table: entity:base.core.Role
    ref_fields: [id]
    on_delete: restrict
indexes:
  - name: idx_user_roles_role
    fields: [role_id]
```

### 6.9 关键约束

- `table.name` 必须在所属 physical_schema 内唯一
- field `base` 必须是 base_types scalar，或 field `ref` 必须是 value_type
- `primary_key` 字段必须都 `required: true`
- `foreign_keys.ref_table` 可以是 `table:` 或 `entity:` 的 $ref
  （物理投影后都解析为物理表名；优先用 entity $ref，因为它表达业务意图）
- 同 physical_schema 内表名唯一；跨 schema 可以重名

## 7. Section 5：entity、mixin、自定义字段数据模型

### 7.1 entity 的角色（简化版）

既然 table 已经承载了扩展策略，entity 就**只剩业务身份层**：

```yaml
# systems/base/core/entity/user.yaml
version: loom-schema/v1
kind: entity
name: User
display_name: 用户
description: 系统用户主体
primary_table: table:base.core.users      # 引用一个 table（已有扩展策略）

# 可选：业务身份专属元数据（留给后续 API/权限/代码生成 spec）
business_keys: [email]                    # 业务唯一标识（区别于主键 id）
audit: true                               # 是否启用审计
```

**entity 的本质**：

- 引用一个 `primary_table`（强引用，必填）
- 在 table 基础上加业务身份元数据
- entity 字段**继承自 table.fields**——不重复声明
  （避免双重真理源；想看字段去 table 文件）
- 后续 API 权限/代码生成 spec 会扩展 entity 添加更多元数据

**为什么 entity 不重复 fields**：YAML 是权威真理源。如果 entity 和 table
都列 fields，谁更新谁？所以 entity 只引用 table，fields 由 table 负责。

**一个 entity → 多个 table（理论占位）**：

```yaml
primary_table: table:base.core.orders
secondary_tables:                        # 可选
  - table: base.core.orders_archive
    role: archive
```

v1 不强制实现，留口子。

### 7.2 mixin：字段组复用机制

`mixin` 是**字段组复用**机制（合并原 fact 概念）。同一组字段在多个
table/entity 中重复出现时，提取为 mixin。两种激活方式：

- **开发期 include**：table 的 `fields:` 数组里写
  `- include: mixin:base._shared.Audit`
- **部署期组装**：通过上层"系统组装 spec"决定哪些 mixin 激活
  （本次不展开）

mixin 字段**落到主表**（物理上直接展开为列）。与 sidecar EAV（运行时动态）
正交。

```yaml
# systems/base/_shared/mixin/audit.yaml
version: loom-schema/v1
kind: mixin
name: Audit
display_name: 审计字段组
description: 标准审计四字段
fields:
  - name: created_at
    base: datetime
    required: true
  - name: updated_at
    base: datetime
    required: true
  - name: created_by
    base: string
    max_length: 100
  - name: updated_by
    base: string
    max_length: 100
```

在 table 里 include：

```yaml
# table/users.yaml
fields:
  - name: id
    base: bigint
    required: true
  - include: mixin:base._shared.Audit       # 整组插入
  - name: email
    ref: value_type:base.core.Email
```

mixin 也可以引用其他 mixin（嵌套），加载器递归展开 + 检测环。

### 7.3 自定义字段数据模型（sidecar EAV）

当 table 配 `strategy: sidecar_eav` 时，物理结构：

```
┌─────────────────────┐         ┌──────────────────────────────────┐
│ users_base          │         │ users_ext                        │
│ (主表，标准字段)     │ 1 ──── N │ (扩展表，EAV)                     │
├─────────────────────┤         ├──────────────────────────────────┤
│ id BIGINT PK        │ ◀────── │ base_id BIGINT  FK→users_base.id │
│ email               │         │ tenant_id BIGINT                  │
│ created_at          │         │ field_name VARCHAR(100)          │
│ ...                 │         │ data_type VARCHAR(20)            │
└─────────────────────┘         │ int_value BIGINT                 │
                                │ decimal_value DECIMAL(18,4)      │
                                │ string_value VARCHAR(...)        │
                                │ datetime_value TIMESTAMPTZ       │
                                │ boolean_value BOOLEAN            │
                                │ json_value JSONB                 │
                                │ created_at TIMESTAMPTZ           │
                                └──────────────────────────────────┘
```

每行 = 一个自定义字段实例。`data_type` 标记值的物理列。

### 7.4 view 自动生成

```sql
CREATE VIEW users AS
SELECT
    u.*,
    -- 把 EAV 行转列（pivot）
    (SELECT string_value FROM users_ext e
     WHERE e.base_id = u.id AND e.field_name = 'nickname'
     LIMIT 1) AS nickname,
    (SELECT decimal_value FROM users_ext e
     WHERE e.base_id = u.id AND e.field_name = 'credit_limit_amount'
     LIMIT 1) AS credit_limit_amount,
    (SELECT string_value FROM users_ext e
     WHERE e.base_id = u.id AND e.field_name = 'credit_limit_currency_code'
     LIMIT 1) AS credit_limit_currency_code
FROM users_base u;
```

view 把多字段 value_type（Money）的自定义字段也展开成多个虚拟列。

### 7.5 自定义字段模板：extension_fields

EAV 表完全动态会带来隐患（任意字段都能加）。`extension_fields` 文件预声明
"允许哪些自定义字段、什么类型"，作为运行时校验和 view 生成的依据。

```
systems/base/core/
  entity/user.yaml                      ← 标准实体
  table/users.yaml                      ← 主表+扩展表
  extension/user_fields.yaml            ← User 的自定义字段模板
```

```yaml
# systems/base/core/extension/user_fields.yaml
version: loom-schema/v1
kind: extension_fields
entity: entity:base.core.User           ← 作用于哪个 entity
fields:
  - name: nickname
    base: string
    max_length: 50
    default_scope: tenant              # 租户级自定义
  - name: credit_limit
    ref: value_type:base.core.Money    # 多字段 value_type 也能用
    default_scope: tenant
  - name: customer_grade
    base: enum
    values: [A, B, C, D]
```

**为什么独立文件**：自定义字段是**部署/配置期**的产物（不同租户、不同项目
不同），生命周期与 entity/table（开发期）不同。混在一起，diff 会被频繁的
部署配置搅乱。单独的 extension/ 目录便于工具扫描。

### 7.6 三层扩展机制总结

| 机制 | 谁触发 | 物理实现 | 是否预声明 | 字段类型 |
|---|---|---|---|---|
| **mixin** | 开发者 include / 部署组装 | 主表（展开为列） | schema 里 include / 声明 | 静态 |
| **sidecar EAV** | 运行时租户/配置 | EAV 扩展表 | extension_fields 预声明 | 动态但受限 |
| **table strategy** | table 配置 | 决定是否有 EAV 表 | table 文件 | 配置项 |

三者正交：任意 strategy（none / json_column / sidecar_eav）都可以叠加 mixin。

## 8. Section 6：工具链（独立于 atlas）

### 8.1 工具链是独立的，atlas 是消费者之一

loom 工具链**完全独立**——不依赖 atlas。atlas 只是 loom 投影器的
众多消费者之一。投影器**不必**输出 atlas-yaml/v2 作为唯一中间格式。

```
loom schema files
       │
       ▼
   Loader (独立实现)
       │
       ▼
   LoadedIR
       │
       ├─→ Projector: DDL  (直接产出 SQL，不经过 atlas)
       ├─→ Projector: atlas-yaml/v2 (可选桥接，复用 atlas 物理 IR)
       ├─→ Projector: Prisma schema (后续 spec)
       ├─→ Projector: OpenAPI (后续 spec)
       └─→ Projector: ORM code (后续 spec)
```

### 8.2 实现位置

**全新独立仓库，TypeScript 实现，Node.js 运行时**。

- **当前阶段**：纯 CLI，运行在 Node.js 上。`loom` 命令是 shell 包装，
  内部 `exec node .../cli/dist/main.js`
- **未来阶段**：可选用 `deno compile` 或 `bun --compile` 编译成单二进制，
  对 atlas 透明。当前留口子，不强制
- **更远未来**：packages/core 设计为环境无关（零运行时依赖、不 import
  Node 专有 API），可被浏览器 web 编辑器复用

loom 不引用任何 atlas 代码，atlas 也不引用 loom 内部包。
atlas 通过子进程调用 `loom`（或 `node .../cli.js`）。

工具链：

| 维度 | 选择 |
|---|---|
| 运行时 | Node.js LTS |
| 语言 | TypeScript（strict mode） |
| 包管理 | pnpm + workspaces |
| Schema 校验 | Zod |
| 测试 | Vitest |
| Lint/Format | Biome |

仓库结构：

```
loom/
  packages/
    core/        ← schema 引擎（纯 TS、零运行时依赖、环境无关）
      src/
        ir/      ← Zod schemas + TS types
        loader/  ← Pass 0-3 加载器
        validator/
        projector/
        fmt/
        lift/
        errors.ts
        deps.ts  ← 依赖图
    cli/         ← CLI 入口（薄包装）
      src/
        main.ts
        commands/{check,fmt,project,lift,version}.ts
      bin/loom   ← shell wrapper
  docs/specs/
  pnpm-workspace.yaml
  biome.json
  vitest.config.ts
  tsconfig.base.json
```

**关键约束**：

- `packages/core` **零运行时依赖**（除 zod），**不 import Node 专有 API**
  （fs/path 通过依赖注入传入），保证将来能在浏览器跑
- `packages/cli` 才能用 Node API（fs、process、stdin/stdout）
- 这就是"为 web UI 留口子"的具体形态

### 8.3 投影器：design → 物理格式

主要投影目标：

| 投影目标 | 用途 | v1 是否实现 |
|---|---|---|
| **SQL DDL** | 直接生成 PostgreSQL / MySQL / SQLite DDL | 是 |
| **atlas-yaml/v2** | 桥接到 atlas 生态（GitOps / DBA 工具链） | 是 |
| **Prisma schema** | 桥接到 Prisma 开发工具链 | 后续 |
| **OpenAPI** | API 层（依赖 entity 业务元数据） | 后续 |
| **ORM 代码** | 代码生成（依赖后续 spec） | 后续 |

### 8.4 关键投影规则

| loom schema 概念 | 物理投影（DDL） |
|---|---|
| table `foo` (strategy=none) | table `foo`，含所有 fields（含 mixin 展开） |
| table `foo` (strategy=json_column) | table `foo` + 额外 `_ext JSONB` 列 |
| table `foo` (strategy=sidecar_eav) | table `foo_base` + table `foo_ext` + view `foo` |
| entity `User` | 不直接投影（通过 primary_table 投影） |
| value_type 单字段 | 1 列（不加后缀） |
| value_type 多字段 | N 列（前缀+字段名） |
| mixin include | 字段直接展开到 table.columns |
| base type `decimal(p,s)` | pg `NUMERIC(p,s)` / mysql `DECIMAL(p,s)` / sqlite `NUMERIC` |
| base type `uuid` | pg `UUID` / mysql `CHAR(36)` / sqlite `TEXT` |
| extension_fields | 生成 view 的虚拟列（pivot 子查询） |

### 8.5 投影器的可重放性（diff-stability）

投影器必须**确定性**：同样的输入（loom schema 文件集 + 同一部署组装配置）
产出字节级一致的物理 schema。

这样：

- design schema diff → 物理 schema diff，可预测
- 重新投影 → 物理 schema 不变（除非真的有语义变更）
- 与 atlas-yaml/v2 的 diff-stability 契约一致

### 8.6 reformat 工具

**问题**：用户手写或 LLM 生成 YAML 时，字段顺序可能不稳定，注释位置不一，
缩进不一致——破坏 diff-stability。

**解决**：`loom fmt`，类似 `gofmt` / `prettier`。

```
loom fmt <path/to/systems>
```

**做这几件事**：

1. **字段排序**：按声明顺序的稳定规则（典型：primary_key 字段 → 普通字段
   → mixin 展开 → 审计字段；或按字段名字母序——具体规则在工具实现期定）
2. **顶层 key 顺序固定**：`version → kind → name → display_name →
   description → table → fields → primary_key → foreign_keys →
   indexes → constraints`
3. **缩进统一**：4 空格（与 atlas-yaml/v2 一致）
4. **字符串引号最小化**：能不加引号就不加，必须加（特殊字符、数字开头）才加
5. **空集合不输出**：避免空 `indexes: []`
6. **`$ref` 字符串化**：与 atlas-yaml/v2 一致，ref 一律字符串而非 map
7. **多文档分隔符标准化**：单文件多 `---` 分隔时，分隔符前后无空行

**Git hook 集成**：pre-commit 跑 `loom fmt` + 校验 dangling $ref +
投影 diff-stability 测试。

### 8.7 校验工具

`loom check`：

- 加载所有文件
- 校验 dangling $ref
- 校验 base type 属性匹配
- 校验 mixin 无环
- 校验 primary_key 字段都 required
- 校验 extension_fields 引用的 entity 存在且其 table 是 sidecar_eav
- 运行投影器，校验产物 diff-stability

### 8.8 CLI 命令总览（v1 最小集）

```
loom check <path>                     # 加载 + 校验
loom fmt <path>                       # 格式化（in-place）
loom project sql --dialect pg --out <dir>      # 投影为 SQL DDL
loom project sql --dialect mysql --out <dir>
loom project sql --dialect sqlite --out <dir>
loom project atlas-yaml --out <dir>   # 桥接 atlas-yaml/v2
loom lift <physical.yaml> --out <dir> # 从物理格式反向提炼
```

`lift` 命令是反向路径——它无法完整还原 design schema（业务身份、扩展策略、
mixin 边界都丢了），只能产出"骨架草稿"，由人工或 LLM 补完。

## 9. 文件 kind 完整枚举

| kind | 路径 | 用途 |
|---|---|---|
| `base_types` | `base_types.yaml`（全局唯一） | 全局标量类型目录 |
| `module_manifest` | `<system>/<module>/MANIFEST.yaml` | 模块元数据 + physical_schema |
| `value_type` | `<system>/<module>/value_type/<name>.yaml` | 用户定义语义类型 |
| `mixin` | `<system>/<module>/mixin/<name>.yaml`（也可放 `_shared/mixin/`） | 字段组复用 |
| `table` | `<system>/<module>/table/<name>.yaml` | 物理表 + 扩展策略 |
| `entity` | `<system>/<module>/entity/<name>.yaml` | 业务身份层 |
| `extension_fields` | `<system>/<module>/extension/<name>.yaml` | sidecar EAV 自定义字段模板 |

## 10. field 的 base 与 ref 互斥规则（统一陈述）

value_type / table / mixin / extension_fields 的 field 元素都必须满足：

- **`base` 和 `ref` 互斥**：一个 field 只能填一个
  - `base: <scalar-name>` → 直接使用 base_types 声明的 scalar
  - `ref: <value_type $ref>` → 引用 value_type，物理投影按 value_type 字段数决定列数
- 二者都缺 → 加载错误 `field must have either base or ref`
- 二者都有 → 加载错误 `field cannot have both base and ref`
- base/ ref 之外的属性（max_length、precision 等）按目标类型在 base_types
  声明的 properties schema 校验

## 11. enum 的处理

enum 在 base_types 列为 scalar（`name: enum`），但**值列表在 value_type
定义**，不在 base_types。流程：

1. base_types 声明 `enum` 接受一个 `values: array<string>` 属性
2. 用户在 value_type 文件里用 `base: enum` + `values: [A, B, C]`：

   ```yaml
   # systems/base/core/value_type/user_status.yaml
   version: loom-schema/v1
   kind: value_type
   name: UserStatus
   display_name: 用户状态
   fields:
     - name: value
       base: enum
       values: [active, inactive, suspended]
   ```

3. 物理投影：
   - PG → 自定义枚举类型 `CREATE TYPE user_status AS ENUM (...)`
   - MySQL → `ENUM('active', 'inactive', 'suspended')`
   - SQLite → `TEXT` + `CHECK (value IN ('active', 'inactive', 'suspended'))`

## 12. mixin include 语法

在 fields 数组里，元素可以是 field 也可以是 include：

```yaml
fields:
  - name: id                         # field
    base: bigint
    required: true
  - include: mixin:base._shared.Audit   # include（整组插入）
  - name: email                      # field
    ref: value_type:base.core.Email
```

加载器加载时遇到 `include:` 把目标 mixin 的 fields **就地展开**到当前
位置（保持顺序），结果就像用户直接写出来的。mixin 也可以引用其他 mixin
（嵌套展开），加载器递归 + 检测环（mixin A include B，B include A 报错）。

## 13. 加载模型与错误约定

### 13.1 加载阶段

加载器分四阶段，每阶段失败都要给出**带文件路径和行号**的错误：

```
Pass 0: Discovery
  └─ 扫描目录，按文件路径推导 identity，建立 path→identity 映射
  └─ 错误：路径不符合 <system>/<module>/<kind>/<name>.yaml 规范

Pass 1: Parse
  └─ YAML 解析为 typed struct，校验 version 和 kind 字段
  └─ 错误：YAML 语法错、version 不匹配、kind 不在枚举内

Pass 2: Link
  └─ 解析所有 $ref，建立 identity→object 映射，回填引用
  └─ 错误：dangling $ref、ref 目标 kind 不匹配、循环 mixin

Pass 3: Validate
  └─ 语义校验（base/ref 互斥、属性 schema、primary_key required、
     extension_fields 引用 sidecar_eav entity、constraints 表达式字段名存在）
  └─ 错误：见下表
```

### 13.2 错误信息格式

与 atlas-yaml/v2 错误模型对齐，所有错误形如：

```
<file>:<line>:<col>: <category>: <message>
```

类别清单：

| 类别 | 何时触发 |
|---|---|
| `parse` | YAML 语法错、字段类型错 |
| `version` | version 字段不匹配 |
| `identity` | 路径与文件内自指冲突、identity 重复 |
| `dangling_ref` | $ref 目标不存在 |
| `kind_mismatch` | $ref 目标 kind 与上下文期望不符（如 ref_table 指向 value_type） |
| `cycle` | mixin 互相 include 形成环 |
| `schema` | base/ref 互斥违反、属性不在 scalar 的 properties schema 内 |
| `semantic` | primary_key 字段非 required、extension_fields 目标 entity 不存在或非 sidecar_eav |
| `project` | 投影器无法落到目标方言（如 SQLite 不支持某特性） |

错误**不可降级为 warning**——loom check 失败必须非零退出码，CI 集成
依赖这一点。

### 13.3 加载器公开 API（TypeScript）

```typescript
// packages/core/loader/index.ts

// 文件系统访问通过注入的 fs 适配器，不直接 import node:fs。
// 这样 core 包可在浏览器/worker 跑（fs 适配器用 in-memory 实现）。
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>
  listFiles(dir: string): AsyncIterable<string>
  stat(path: string): Promise<{ mtimeMs: number; size: number }>
}

export interface LoadOptions {
  fs: FileSystem                              // 必填：注入 fs 适配器
  systemFilter?: string[]                     // 只加载指定 system
  maxConcurrency?: number                     // 默认 8
  cache?: Cache                               // 增量加载缓存（v1.1+）
  basePath: string                            // loom schema 根目录
}

export interface LoadResult {
  ir: IR                                      // 不可变快照
  diagnostics: Diagnostics                    // 收集所有错误/警告
}

export async function load(opts: LoadOptions): Promise<LoadResult>
```

`IR` 是加载后的不可变快照，包含所有 entity/table/value_type/mixin/
extension_fields/base_types 的解析结果，以及完整的依赖图。

## 14. 依赖图与增量加载

### 14.1 依赖图

加载器在 Pass 2 末尾构建依赖图：

- 节点：每个 identity（entity / table / value_type / mixin / extension_fields）
- 边：`A → B` 表示 A 引用了 B（field ref / mixin include / table ref /
  extension_fields.entity / primary_table）

用途：

- **影响分析**：改了一个 value_type，哪些 table/entity 受影响？
- **增量校验**：只重校受影响子图
- **可视化**：`loom graph --entity base.core.User` 输出该 entity 的依赖子图

### 14.2 增量加载（v1.1+，非阻塞 v1）

v1 全量加载，简化实现。v1.1 引入文件级 mtime/hash 缓存：

- 缓存键：文件路径 + 内容 SHA256
- 缓存值：解析后的 IR 节点 + 依赖图边
- 失效：mtime 变或 hash 变则重解析；依赖图反向传播失效

大型 ERP schema（数千文件）下，全量加载目标 < 3 秒；增量加载目标 < 300ms。

## 15. Lifecycle / Migration 策略

### 15.1 loom 不生成 migration

loom 描述 schema **状态**，不描述**变更计划**。migration 由 atlas 的
`migrate` 包负责。

### 15.2 与 atlas migrate 的衔接

```
loom schema (v1)  ──┐
                    ├──▶ atlas migrate diff ──▶ migration.sql
loom schema (v2)  ──┘     (atlas 自己解 diff)
```

工作流：

1. 开发者改 loom schema 文件（v1 → v2）
2. 跑 `loom project atlas-yaml --out v2.physical.yaml`
3. 跑 `atlas migrate diff --from v1.physical.yaml --to v2.physical.yaml`
4. 产出 `migration.sql`，走 atlas 现有的 migration review 流程

这样 loom 不重复实现 migration 算法，复用 atlas 的成熟实现。

### 15.3 breaking change 处理

loom schema 的不向后兼容变更（删字段、改类型）会通过 projection 反映到
物理 schema，再由 atlas migrate 检测。**loom 不做破坏性变更的兜底**——
明确报错让开发者写显式 migration（rename、backfill 等）。

## 16. 与 atlas CLI 的集成协议

loom 是独立二进制，atlas 通过子进程调用。

### 16.1 命令调用约定

```
atlas 内部需要 loom schema 信息时:
  loom project atlas-yaml --input <loom-schema-dir> --stdout
  ↑ 输出 atlas-yaml/v2 文本到 stdout，atlas 用管道读

若未安装为全局 loom 命令，atlas 可直接调 node:
  node /path/to/loom/packages/cli/dist/main.js project atlas-yaml \
       --input <dir> --stdout
```

- **stdin**：默认不读，除非 `--input -` 从 stdin 读 loom schema tar
- **stdout**：成功时输出产物（YAML/SQL/JSON），失败时空
- **stderr**：人类可读的诊断信息（含 file:line:col）
- **exit code**：0 成功；1 加载/校验失败；2 投影失败；64+ 用法错误
- **环境要求**：Node.js LTS（未来可换 deno/bun 单二进制）

### 16.2 版本协商

atlas 在调用 loom 前跑 `loom version`，检查：

```
loom version
loom v0.1.0
schema-versions-supported: loom-schema/v1
```

atlas 自己的 `atlas.yaml` 配置里声明 `loom.min_version: 0.1.0`，过低则报错。

### 16.3 不做的事

- atlas 不直接 import loom 的 Go 包（保持进程隔离）
- loom 不调用 atlas（loom 是被调用方）
- 不通过共享文件系统隐式传递状态（除非用户显式指定 `--input/--out`）

## 17. CI 集成

### 17.1 GitHub Actions 示例

```yaml
# .github/workflows/schema-check.yml
on: { pull_request: { paths: ['systems/**'] } }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: nzinfo/setup-loom@v1           # 待开发
      - run: loom fmt --check systems/        # 非零退出码 = 格式不符
      - run: loom check systems/              # 校验
      - run: |
          loom project sql --dialect pg --out /tmp/expected-pg.sql systems/
          git diff --exit-code /tmp/expected-pg.sql checked-in-pg.sql
          # 若仓库内 commit 了预期产物，校验未被手动篡改
```

### 17.2 pre-commit hook

```bash
#!/bin/sh
# .git/hooks/pre-commit
loom fmt systems/
git add systems/
loom check systems/ || exit 1
```

## 18. 测试策略

### 18.1 单元测试（per package）

- `loader`：每种 kind 的解析、错误路径覆盖
- `validator`：每条语义规则的 positive + negative case
- `projector`：每个 base type × 每方言 → 物理 type 映射；每个 strategy × 方言
- `fmt`：不规则输入 → 规范输出；规范输入 → 不变（幂等）

### 18.2 集成测试

- **Round-trip**：loom schema → project atlas-yaml → 反向 lift → 比对
  （lift 不可逆部分用 fixture 标注）
- **Diff-stability**：同一组 loom schema 两次 project，bytes 必须一致
- **Golden files**：`testdata/systems/base/core/` 一组 reference schema，
  产出 SQL/YAML 进 `testdata/golden/`，CI 比对

### 18.3 性能基准

- BenchmarkLoad_100Files
- BenchmarkLoad_1000Files
- BenchmarkProject_PGLarge（含 sidecar_eav + 多个 mixin）
- 目标：v1 加载 < 3s/1000 files；project < 1s/100 tables

## 19. 待设计章节

- [ ] 无（v1 spec 范围已完整）

## 20. 不在本次 spec 范围（已明确）

- API 权限层（CRUD 端点、字段级可见性、角色）
- 业务语义层（聚合根、值对象文档、displayName 多语言）
- 代码生成元数据（前端表单、校验提示、UI 展示）
- 系统组装 / 部署组合 spec
- migration 生成（由投影器单独生成，本 spec 只描述状态）
- 投影器到 Prisma / OpenAPI / ORM 的具体规则（后续 spec）
- 增量加载（v1.1+）
- LLM 辅助编辑/补全（v1.2+，作为独立工具，不进 loom 核心）
