# loom 用户手册

> 本手册由浅入深介绍 loom 的使用方法：从安装、第一个 schema，到 mixin、value_type、
> sidecar EAV 扩展，最后到编程式调用与 CI 集成。
>
> loom 是一个**前向设计（design-first）**的 Schema 描述语言引擎：你用 YAML 描述
> 设计模型（实体、值类型、混入、表、扩展字段），loom 把它投影成可直接执行的物理
> SQL DDL（PostgreSQL / MySQL / SQLite）。
>
> 核心理念：**先建模，再投影**。设计层关注语义（"用户有邮箱、有余额"），投影层
> 关注物理实现（"邮箱是 VARCHAR(254)、余额是 NUMERIC(18,4)，扩展字段走 sidecar
> EAV 表 + 透视视图"）。

## 目录

- [第 1 章 安装与速览](#第-1-章-安装与速览)
- [第 2 章 目录结构与身份约定](#第-2-章-目录结构与身份约定)
- [第 3 章 第一个 Schema：从 YAML 到 SQL](#第-3-章-第一个-schema从-yaml-到-sql)
- [第 4 章 base_types：可用标量目录](#第-4-章-base_types可用标量目录)
- [第 5 章 value_type：语义类型包装](#第-5-章-value_type语义类型包装)
- [第 5.5 章 using 导入机制](#第-55-章-using-导入机制)
- [第 6 章 mixin：字段组复用](#第-6-章-mixin字段组复用)
- [第 7 章 entity 与 module_manifest](#第-7-章-entity-与-module_manifest)
- [第 8 章 三种扩展策略与 sidecar EAV](#第-8-章-三种扩展策略与-sidecar-eav)
- [第 9 章 extension_fields：自定义字段模板](#第-9-章-extension_fields自定义字段模板)
- [第 10 章 枚举、索引、外键](#第-10-章-枚举索引外键)
- [第 11 章 `$ref` 引用语法](#第-11-章-ref-引用语法)
- [第 12 章 CLI 命令参考](#第-12-章-cli-命令参考)
- [第 13 章 加载管线与诊断](#第-13-章-加载管线与诊断)
- [第 14 章 编程式调用](#第-14-章-编程式调用)
- [第 15 章 CI / Git 集成](#第-15-章-ci--git-集成)
- [第 16 章 已知局限与路线](#第-16-章-已知局限与路线)
- [附录 A 完整工作示例](#附录-a-完整工作示例)
- [附录 B 错误类别速查](#附录-b-错误类别速查)

---

## 第 1 章 安装与速览

### 1.1 环境要求

- Node.js ≥ 20
- pnpm（推荐 v9+）

### 1.2 安装

```sh
cd /path/to/loom
pnpm install
pnpm -r run build
```

loom 是一个 pnpm 工作区，包含两个包：

- `@loom/core` — 引擎（环境无关，不依赖 `node:fs`；文件系统通过依赖注入）
- `@loom/cli` — Node.js 命令行包装

### 1.3 三个核心命令

```sh
# 1. 查看版本（机器可读，供 atlas 等下游协商）
loom version

# 2. 加载 + 校验 schema 树（不生成产物）
loom check <path-to-schema-root>

# 3. 投影为 SQL DDL
loom project sql --dialect pg <path-to-schema-root>
loom project sql --dialect mysql --out schema.sql <path-to-schema-root>
loom project sql --dialect sqlite <path-to-schema-root>
```

退出码：`0` 成功、`1` 加载/校验失败、`2` 投影失败、`64` 用法错误。

### 1.4 三十秒体验

如果只想看看输出长什么样，可以直接跑仓库自带的黄金固件测试：

```sh
pnpm --filter @loom/core test
```

`packages/core/tests/golden/base_schema.pg.sql` 是真实投影输出，下文会逐步拆解。

---

## 第 2 章 目录结构与身份约定

loom 最核心的设计是**"路径即身份"**：你不需要在文件头声明 system/module/kind/name，
它们直接由文件路径推导。

### 2.1 标准布局

```
my-schema/
├── base_types.yaml                # 全局唯一，可用标量目录
└── systems/
    └── <system>/
        └── <module>/
            ├── MANIFEST.yaml      # kind: module_manifest
            ├── value_type/
            │   └── <name>.yaml
            ├── mixin/
            │   └── <name>.yaml
            ├── table/
            │   └── <name>.yaml
            ├── entity/
            │   └── <name>.yaml
            └── extension/
                └── <name>.yaml    # kind: extension_fields
```

所有 kind 一律落到**模块目录**下，按 kind 分子目录。跨模块复用通过 `using` 导入
和 `module_manifest.exports` 表达（详见 §5.5、§7.2），不另设共享目录。

### 2.2 路径推导身份

```
systems/base/core/entity/user.yaml
└system─┘ └module┘ └kind┘ └name┘
=> identity = entity:base.core.User
```

**关键规则：**

- 目录/文件名用 **kebab-case**（`user-profile.yaml`）
- 推导出的逻辑名转 **PascalCase**（`user` → `User`，`user-profile` → `UserProfile`）
- `extension/` 目录映射到 `extension_fields` kind（不对称，唯一例外）
- 物理表名在 `table.name` 字段显式声明（不依赖推导）

### 2.3 文件头格式

每个文件顶格两行：

```yaml
version: loom-schema/v2
kind: <entity | table | value_type | mixin | module_manifest | extension_fields | base_types>
# 之后是该 kind 的内容
```

`version` 是 wire 版本号，破坏性变更必须 bump。reader 严格匹配。
v2（`loom-schema/v2`）引入统一 `type:` 键与 `using` 导入机制，不兼容 v1（详见
`docs/specs/2026-06-18-loom-v2-type-system.md`）。

---

## 第 3 章 第一个 Schema：从 YAML 到 SQL

我们从最小可运行的例子开始，逐步加料。

### 3.1 创建项目骨架

```sh
mkdir -p my-schema/systems/base/core/{value_type,table,entity,extension,mixin}
touch my-schema/base_types.yaml
```

### 3.2 写 base_types.yaml

先声明两个最常用的标量：

```yaml
# my-schema/base_types.yaml
version: loom-schema/v2
kind: base_types

scalars:
  - name: bigint
    description: 64-bit integer
    properties: []
  - name: string
    description: var-length string
    properties:
      - name: max_length
        type: integer
        required: true
  - name: datetime
    description: timestamp
    properties: []
```

### 3.3 写 MANIFEST.yaml

```yaml
# my-schema/systems/base/core/MANIFEST.yaml
version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
description: core module
```

`physical_schema` 决定了这个模块下所有表的物理 schema 前缀（PG schema / MySQL database）。

### 3.4 写第一张表

```yaml
# my-schema/systems/base/core/table/users.yaml
version: loom-schema/v2
kind: table
name: Users
table:
  name: users
  extension:
    strategy: none
fields:
  - name: id
    type: bigint
    required: true
  - name: email
    type: string
    max_length: 254
    required: true
primary_key: [id]
```

v2 用单一 `type:` 键表达字段类型（替代 v1 的 `base` / `ref` 互斥键）：
单段短名（如 `bigint`、`string`）解析到 base_types 标量；三段全限定名
（如 `base.core.Email`）解析到 value_type 节点。详见第 5 章。

### 3.5 校验

```sh
loom check my-schema/
```

无输出 = 通过。退出码 0。

### 3.6 投影

```sh
loom project sql --dialect pg my-schema/
```

输出（节选）：

```sql
CREATE TABLE base_core.users (
  id BIGINT NOT NULL,
  email VARCHAR(254) NOT NULL,
  PRIMARY KEY (id)
);
```

试试其他方言：

```sh
loom project sql --dialect mysql my-schema/    # DECIMAL 不带方言语义
loom project sql --dialect sqlite my-schema/   # 主键自增、CHECK IN 等
```

---

## 第 4 章 base_types：可用标量目录

`base_types.yaml` 是整个系统的"原子词汇表"——所有 value_type、table field、
entity field 最终都要落到这些标量之一。

### 4.1 设计取向

- base_types 只列**逻辑类型名 + 抽象属性**（如 `decimal` 有 `precision/scale`，
  `string` 有 `max_length`），**不绑定方言**
- 方言映射在投影器里集中管理（`decimal` → PG `NUMERIC(18,4)` / MySQL `DECIMAL(18,4)`
  / SQLite `NUMERIC`）
- v2 内**不可扩展**：想加新标量，需改 base_types.yaml + 投影器并 bump 版本号

### 4.2 推荐内置标量

```yaml
scalars:
  - { name: boolean,   description: 布尔值, properties: [] }
  - { name: integer,   description: 整数, properties: [{name: min, type: integer}, {name: max, type: integer}] }
  - { name: bigint,    description: 64位整数, properties: [] }
  - name: decimal
    description: 定点小数（金额、计量）
    properties:
      - { name: precision, type: integer, required: true }
      - { name: scale, type: integer, required: true }
  - name: string
    description: 变长字符串
    properties:
      - { name: max_length, type: integer, required: true }
      - { name: pattern, type: string }
  - { name: text, description: 长文本, properties: [] }
  - { name: datetime, description: 时间戳, properties: [] }
  - { name: date, description: 日期, properties: [] }
  - { name: uuid, description: UUID, properties: [{name: version, type: integer}] }
  - { name: bytes, description: 二进制, properties: [{name: max_length, type: integer}] }
  - { name: json, description: JSON, properties: [] }
  - name: enum
    description: 枚举（值列表在 value_type 定义）
    properties:
      - { name: values, type: array<string>, required: true }
```

### 4.3 关键约束

- **唯一权威**：value type / table field 引用的 scalar 必须在此声明，否则报
  `unknown scalar` 错误（v2 把所有字段统一到 `type:` 键，scalar 通过短名或
  `base.core.<Scalar>` 全限定名引用）
- **不出现方言**：base_types 不写 `pg: NUMERIC`，由投影器决定
- **属性有类型**：属性自身用 base_type（递归闭包），保证可校验

---

## 第 5 章 value_type：语义类型包装

value_type 是用户定义的"语义类型"，介于 base_type scalar 和 field 之间，解决两件事：

1. **newtype 包装**：给 scalar 加语义标签（`Email = string` + 正则 + 长度），避免
   把 `user_email` 和 `invoice_email` 当成同一种 string 混用
2. **多字段映射**：一个业务概念需要多列才能完整表达（如 Money = amount + currency）

### 5.1 单字段 value_type（newtype）

内部字段名**必须叫 `value`**，这样投影才不附加后缀：

```yaml
# systems/base/core/value_type/email.yaml
version: loom-schema/v2
kind: value_type
name: Email
display_name: 邮箱
fields:
  - name: value
    type: string
    max_length: 254
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

也可以在文件顶部用 `using:` 导入后写短名（详见 §5.5）：

```yaml
using:
  - base.core.*
fields:
  - name: email
    type: Email                       # 短名，等价于 base.core.Email
```

### 5.2 多字段 value_type

```yaml
# systems/base/core/value_type/money.yaml
version: loom-schema/v2
kind: value_type
name: Money
fields:
  - name: amount
    type: decimal
    precision: 18
    scale: 4
    required: true
  - name: currency_code
    type: string
    max_length: 3
    required: true
```

引用它，**列名 = `<前缀>_<子字段>`**：

```yaml
fields:
  - name: balance
    type: base.core.Money
# → 物理：balance_amount NUMERIC(18,4), balance_currency_code VARCHAR(3)
```

### 5.3 投影规则速查

| value_type 形态 | 内部字段名 | 引用时列数 | 列名规则 |
|---|---|---|---|
| 单字段 newtype | `value` | 1 | 引用字段名（无后缀） |
| 多字段 | 任意 | N | `<引用字段名>_<子字段名>` |

投影规则本身与 v1 一致，只是输入语法的 `base`/`ref` 键合并成了单一 `type:`。

### 5.4 单一 `type:` 键

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

**错误情况**：

- field 没有 `type:` → `field must have a type`
- `type: foo.bar.Baz` 节点不存在 → `unknown type "foo.bar.Baz"`
- `type: foo.bar.Baz` 目标 kind 不是 value_type →
  `type reference "foo.bar.Baz" resolves to kind=entity, expected value_type`
- `type: integer` base_types 里没有 → `unknown scalar "integer"`

---

## 第 5.5 章 using 导入机制

v2 引入编程语言式的 `using:` 导入机制（类比 C# `using`、Java `import`、Go `import`），
让你用短名引用 value_type，不必每次写三段全限定名。

### 5.5.1 动机

`type: base.core.Email` 比 v1 的 `ref: value_type:base.core.Email` 干净，但每次
都写三段名仍然啰嗦。using 提供：

- **可读性**：`type: Money` 比 `type: base.core.Money` 干净
- **模块边界自文档化**：using 列表显式声明"这个文件依赖哪些模块的类型"
- **重构友好**：移动 value_type 到另一模块，改 using 而非改所有引用处
- **LSP / 补全友好**：using 列表给工具明确的补全范围

### 5.5.2 文件级声明

每个 .yaml 文件**顶部**声明自己的 using 列表（类比 C# per-file `using`，而非 Go
package-level `import`）。模块内的不同文件可以有不同 using——更灵活，避免一个文件
引入整个模块不需要的依赖。

```yaml
# systems/retail/pos/table/orders.yaml
version: loom-schema/v2
kind: table
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

### 5.5.3 默认导入：`base.core.*`

每个文件**隐含** `using: [base.core.*]`，base_types 标量在任何文件里都可以直接用
短名（`integer`、`string`、`decimal`、`enum`、`datetime`...），无需显式声明。

类比 Java 默认 `java.lang.*`、C# 默认 `System`、Go 的 builtins。

### 5.5.4 A 与 B 统一语法

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

### 5.5.5 短名解析规则

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

### 5.5.6 歧义检测

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

### 5.5.7 形态 C（重命名）：挂起

形态 C 用于命名冲突消解（在文件内给某个类型起别名）。**v2 不实现**，语法待定。
冲突的临时解决办法就是上一节的全限定名。详见 spec §4.5。

### 5.5.8 using 的校验

- using 条目的命名空间或精确名必须存在 → 否则 `unknown using target "..."`
- using 列表为空时可省略 `using:` 键

---

## 第 6 章 mixin：字段组复用

当一组字段在多张表里重复（如标准审计四字段 `created_at`/`updated_at`/`created_by`/
`updated_by`），提取成 mixin。

### 6.1 定义 mixin

```yaml
# systems/base/core/mixin/audit.yaml
version: loom-schema/v2
kind: mixin
name: Audit
display_name: 审计字段组
fields:
  - { name: created_at, type: datetime, required: true }
  - { name: updated_at, type: datetime, required: true }
```

mixin 与其他 kind 一样落在**模块目录**下（`<system>/<module>/mixin/`），身份形如
`mixin:base.core.Audit`。跨模块复用时由目标模块 `using` 导入。

### 6.2 在 table 里 include

```yaml
# systems/base/core/table/users.yaml
fields:
  - name: id
    type: bigint
    required: true
  - include: mixin:base.core.Audit        # 整组插入到当前位置
  - name: email
    type: base.core.Email
    required: true
    unique: true
```

加载器遇到 `include:` 把目标 mixin 的 fields **就地展开**到当前位置（保持顺序），
结果就像直接写出来一样。

### 6.3 嵌套与循环

mixin 也可以 include 其他 mixin（嵌套展开）。加载器递归展开 + 检测环——
`A include B, B include A` 会报 `cycle` 错误。

mixin **物理上落到主表**（展开为列），与运行时 sidecar EAV 完全正交。

---

## 第 7 章 entity 与 module_manifest

### 7.1 entity：业务身份层

`table` 承载物理结构 + 扩展策略；`entity` 在 table 之上加**业务身份**：

```yaml
# systems/base/core/entity/user.yaml
version: loom-schema/v2
kind: entity
name: User
display_name: 用户
description: 系统用户主体
primary_table: table:base.core.Users     # 强引用一张 table（身份引用，kind 前缀保留）
business_keys: [email]                   # 业务唯一标识（区别于主键 id）
audit: true
```

**关键点：**

- entity **不重复 fields**——fields 由 table 负责，避免双重真理源
- entity 的本质是"引用一张 primary_table + 加业务身份元数据"
- `primary_table:` 是**身份引用**，保留 `table:` kind 前缀（详见 §11.2）
- v2 投影时 entity 不直接投影，只通过 primary_table 投影

### 7.2 module_manifest：physical_schema 归属

物理 schema 空间（PG schema / MySQL database）是**模块级别决策**，不该 per-table 配置：

```yaml
# systems/base/core/MANIFEST.yaml
version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
description: 基础核心模块
exports:                                   # 可选：声明对外的导出（身份引用形式）
  - entity:base.core.User
  - value_type:base.core.Email
```

好处：

- 模块迁移（重命名 physical_schema）只改一处
- table 文件聚焦于"这张表长什么样"
- 与 ERP 的"模块化部署"哲学一致

加载器加载 table 时，自动从所属 module 的 MANIFEST 补全完整物理位置
（`base_core.users_base`）。

---

## 第 8 章 三种扩展策略与 sidecar EAV

`table.table.extension.strategy` 决定如何承载自定义字段：

| strategy | 物理布局 | 适用场景 | view 是否必填 |
|---|---|---|---|
| `none` | 单表 `foo` | 审计、配置、关联表 | 否 |
| `json_column` | 单表 `foo`，加 `_ext JSONB` 列 | 简单少量自定义字段 | 否 |
| `sidecar_eav` | `foo_base` + `foo_ext` + view `foo` | ERP 大量动态字段 | 是 |

### 8.1 none（默认）

```yaml
table:
  name: user_roles
  extension:
    strategy: none
```

### 8.2 json_column

```yaml
table:
  name: settings
  extension:
    strategy: json_column
```

投影会附加 `_ext JSONB` 列（MySQL 用 JSON，SQLite 用 TEXT）。

### 8.3 sidecar_eav（推荐用于 ERP 场景）

```yaml
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
```

物理结构：

```
┌─────────────────────┐         ┌──────────────────────────────────┐
│ users_base          │         │ users_ext                        │
│ (主表)              │ 1 ──── N │ (EAV 扩展表)                     │
├─────────────────────┤         ├──────────────────────────────────┤
│ id BIGINT PK        │ ◀────── │ base_id BIGINT  FK→users_base.id │
│ email               │         │ tenant_id BIGINT                  │
│ created_at          │         │ field_name VARCHAR(100)          │
│ ...                 │         │ data_type VARCHAR(20)            │
└─────────────────────┘         │ int_value BIGINT                 │
                                │ decimal_value DECIMAL(18,4)      │
                                │ string_value TEXT                │
                                │ datetime_value TIMESTAMPTZ       │
                                │ boolean_value BOOLEAN            │
                                │ json_value JSONB                 │
                                │ created_at TIMESTAMPTZ           │
                                └──────────────────────────────────┘
```

每行 = 一个自定义字段实例。`data_type` 标记值的物理列。

### 8.4 自动生成的 view

```sql
CREATE VIEW users AS
SELECT
  id,
  created_at,
  updated_at,
  email,
  (SELECT string_value FROM users_ext e
   WHERE e.base_id = u.id AND e.field_name = 'nickname' LIMIT 1) AS nickname
FROM base_core.users_base u;
```

view 把 EAV 行转列（pivot 子查询）。**应用代码始终用 view 名（`users`）**，
不直接访问 `_base`/`_ext`。

### 8.5 物理表名编码约定

- `none` / `json_column`：`foo`
- `sidecar_eav`：`foo_base`（主表）+ `foo_ext`（扩展表），view 暴露 `foo`

三种策略可以叠加 mixin（彼此正交）。

---

## 第 9 章 extension_fields：自定义字段模板

EAV 表完全动态会带来隐患（任意字段都能加）。`extension_fields` 文件**预声明**
"允许哪些自定义字段、什么类型"，作为运行时校验和 view 生成的依据。

### 9.1 定义模板

```yaml
# systems/base/core/extension/user_fields.yaml
version: loom-schema/v2
kind: extension_fields
entity: entity:base.core.User           # 作用于哪个 entity（身份引用，kind 前缀保留）
fields:
  - name: nickname
    type: string
    max_length: 50
    default_scope: tenant              # 租户级自定义
  - name: credit_limit
    type: base.core.Money              # 多字段 value_type 也能用
    default_scope: tenant
  - name: customer_grade
    type: base.core.CustomerGrade      # enum 强制走 value_type（详见 §10.1）
    default_scope: tenant
```

### 9.2 为什么独立文件

自定义字段是**部署/配置期**产物（不同租户、不同项目不同），生命周期与
entity/table（开发期）不同。混在一起，diff 会被频繁的部署配置搅乱。
单独的 `extension/` 目录便于工具扫描与租户级差异管理。

### 9.3 view 中的展开

模板里声明的每个字段都会在 view 里展开成虚拟列。多字段 value_type（如 Money）
会展开成多个虚拟列（`credit_limit_amount`、`credit_limit_currency_code`）。

---

## 第 10 章 枚举、索引、外键

### 10.1 枚举

enum 在 base_types 列为 scalar，但**值列表在 value_type 定义**。v2 取消了 v1 的
inline enum 写法（在 table / extension_fields 的 field 里直接写
`base: enum, values: [...]`），enum 值列表**只能**在 value_type 文件里声明：

```yaml
# systems/base/core/value_type/user_status.yaml
version: loom-schema/v2
kind: value_type
name: UserStatus
fields:
  - name: value
    type: enum                         # enum 是 base_types 短名
    values: [active, inactive, suspended]
```

引用处和其他 value_type 完全一样：

```yaml
fields:
  - name: status
    type: base.core.UserStatus         # 或经 using 短名：type: UserStatus
```

enum 不再特殊——它就是一个内部字段类型为 `enum` 标量的 value_type。

> **v2 破坏性变更**：v1 允许在任意 field 处 inline 写 `base: enum, values: [...]`，
> v2 取消。inline enum 让"值列表放哪"暧昧（同一组 enum 可能散落在多处重复声明），
> 无法统一管理。迁移方法：把每个 inline enum 提到独立的 value_type 文件，引用处
> 改为 `type: <fqn>`。

物理投影：

| 方言 | DDL |
|---|---|
| PostgreSQL | `CREATE TYPE user_status AS ENUM ('active','inactive','suspended');` + 列类型引用 |
| MySQL | 列内联 `ENUM('active','inactive','suspended')` |
| SQLite | `TEXT` + `CHECK (value IN ('active','inactive','suspended'))` |

### 10.2 索引

```yaml
indexes:
  - name: idx_users_email
    fields: [email]
    unique: true
```

### 10.3 外键

```yaml
# systems/base/core/table/user_roles.yaml
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

### 10.4 关键约束

- `table.name` 必须在所属 physical_schema 内唯一
- `primary_key` 字段必须都 `required: true`
- `decimal` 必须有 `precision` + `scale`
- 同 physical_schema 内表名唯一；跨 schema 可以重名

---

## 第 11 章 `$ref` 引用语法

loom 的跨文件引用是字符串（不是 map）。v2 把引用明确分成两个名字空间：
**类型引用**（无 kind 前缀）和**身份引用**（带 kind 前缀）。两者解析路径不同，
不可混用。

### 11.1 类型引用（field `type:`）

**形态**：三段名 `sys.mod.Name`，**不带** kind 前缀。

用于 field 的 `type:` 键，目标必须是 value_type 节点。

```
base.core.Email              ← base/core/value_type/email.yaml
base.core.Money              ← base/core/value_type/money.yaml
retail.pos.types.OrderId     ← retail/pos/types/value_type/order_id.yaml
```

逻辑名是 PascalCase（与推导规则一致）。

**解析路径**（详见 spec §4.6）：

1. 单段短名（`Money`）→ 先查 base_types 注册表，再查当前文件 using 列表
2. 三段全限定（`base.core.Money`）→ 直接查节点表，验证 `kind === 'value_type'`
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
- 目标 kind 不是 value_type →
  `type reference "X" resolves to kind=entity, expected value_type`
- 目标不存在 → `unknown type "X"`

### 11.2 身份引用（非类型）

**形态**：四段 `kind:sys.mod.Name`，**带** kind 前缀。

用于"这不是字段的类型，而是指向某个节点"的场景。kind 前缀必须与目标节点的
`kind` 字段匹配，加载器按身份表查找。

```
entity:base.core.User             ← base/core/entity/user.yaml
table:base.core.Users             ← base/core/table/users.yaml
mixin:base.core.Audit             ← base/core/mixin/audit.yaml
value_type:base.core.Email        ← base/core/value_type/email.yaml
```

**身份引用出现在哪些位置**：

| 位置 | 示例 | 说明 |
|---|---|---|
| `primary_table:` | `primary_table: table:base.core.Users` | entity 强引用一张 table |
| `ref_table:`（foreign_keys） | `ref_table: entity:base.core.User` | FK 引用目标表 |
| `- include:`（mixin） | `- include: mixin:base.core.Audit` | fields 数组里展开 mixin |
| `entity:`（extension_fields） | `entity: entity:base.core.User` | extension_fields 作用于哪个 entity |
| `exports:`（module_manifest） | `- value_type:base.core.Email` | 声明对外导出的节点 |

```yaml
fields:
  - name: id                           # field（类型引用走 type:）
    type: bigint
  - include: mixin:base.core.Audit     # 身份引用（mixin 展开到 fields）
```

### 11.3 为什么分两个名字空间

类型论上，"字段的类型"和"指向某个节点"是两件事：

- **类型引用**回答"这个字段是什么类型"——目标必须是 value_type（能投影成列），
  加载器验证 `kind === 'value_type'`。类型引用走更窄的名字空间（三段、无 kind），
  因为"是不是类型"由被引用节点自身的 `kind` 决定，不需要引用者再标。
- **身份引用**回答"我要指哪个节点"——目标可以是任意 kind（entity / table / mixin /
  value_type），kind 前缀让引用者和加载器都明确"我在找哪种节点"。
  `primary_table` 必须是 table，`include` 必须是 mixin，`entity:` 必须是 entity。

两套名字空间通过"被引用节点 `kind === 'value_type'`"这一条规则连接，互不冲突。
加载器内部维护两张查表：身份表（全 identity → node）、类型表（sys.mod.Name →
value_type node）。

### 11.4 悬挂 ref

`$ref` 目标不存在时报 `dangling_ref` 错误。kind 与上下文不符
（如 `ref_table` 指向 value_type）报 `kind_mismatch`。
类型引用的 kind 校验失败（目标非 value_type）报
`type reference "..." resolves to kind=..., expected value_type`。

---

## 第 12 章 CLI 命令参考

```
loom version                                    打印版本信息（spec §16.2）
loom check <path>                               加载 + 校验（spec §8.7）
loom project sql --dialect <d> [--out <f>] <path>
                                                投影为 SQL DDL
                                                <d>: pg | mysql | sqlite
loom fmt <path>                                 格式化（未实现）
loom lift <physical.yaml>                       反向提炼（未实现）
```

### 12.1 version

机器可读格式，供下游（atlas 等）协商版本：

```
loom 0.2.0
schema-versions-supported: loom-schema/v2
current: loom-schema/v2
```

### 12.2 check

加载整个 schema 树并校验，不生成任何产物。所有诊断输出到 stderr。

```sh
loom check my-schema/
echo $?     # 0 通过，1 失败
```

### 12.3 project sql

```sh
# stdout
loom project sql --dialect pg my-schema/

# 写入文件
loom project sql --dialect mysql --out schema.sql my-schema/
```

方言必须显式指定。`--out` 省略时写 stdout。

### 12.4 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 加载 / 校验失败 |
| 2 | 投影失败 |
| 64 | 用法错误 |

---

## 第 13 章 加载管线与诊断

loom 的加载是确定性的 4 阶段管线，**永不抛异常**——所有错误进入 `diagnostics`。

### 13.1 四阶段

```
Pass 0  Discovery     扫描目录，按路径推导 identity
                      错误：路径不符合 <system>/<module>/<kind>/<name>.yaml 规范

Pass 1  Parse         YAML → typed struct，校验 version 和 kind
                      错误：YAML 语法错、version 不匹配、kind 不在枚举内

Pass 2  Link          解析所有 $ref，建立 identity→object 映射
                      错误：dangling_ref、kind_mismatch、cycle（mixin 环）

Pass 3  Validate      语义校验
                      错误：type 缺失或解析失败、属性 schema 不匹配、
                            primary_key 非 required、extension_fields 引用
                            非 sidecar_eav entity、decimal 缺 precision/scale
```

Pass 2 即使有 parse 错误也会运行（为了暴露尽可能多的诊断）。

### 13.2 错误格式

```
<file>:<line>:<col>: <category>: <message>
```

> **v0.2.0 已知局限**：诊断信息行号列号硬编码为 `1:1`，精确位置追踪未实现。

### 13.3 错误不可降级

错误**不可降级为 warning**——`loom check` 失败必须非零退出码，CI 集成依赖这一点。

---

## 第 14 章 编程式调用

`@loom/core` 完全环境无关——不依赖 `node:fs`，文件系统通过依赖注入。

### 14.1 最小调用

```typescript
import { load, projectSqlFromIr } from '@loom/core';
import { NodeFileSystem } from './my-fs-adapter';

const { ir, diagnostics } = await load({
  fs: new NodeFileSystem(),
  basePath: '/path/to/my-schema',
});

if (diagnostics.hasErrors) {
  for (const d of diagnostics.all) console.error(d.message);
  process.exit(1);
}

const sql = projectSqlFromIr(ir, 'pg');     // 'pg' | 'mysql' | 'sqlite'
console.log(sql);
```

### 14.2 FileSystem 接口

core 包不直接读文件。你需要实现 `FileSystem`：

```typescript
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  listFiles(dir: string): AsyncIterable<string>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
}
```

这样 core 可以在浏览器（用 fetch / in-memory map）、Deno、worker 中跑——
测试用的 `MemoryFileSystem` 就是基于一个 `Map<string, string>` 实现的。

### 14.3 取物理模型（不走 SQL）

```typescript
import { load, expandTables } from '@loom/core';

const { ir } = await load({ fs, basePath });
const model = expandTables(ir);

for (const t of model.tables) {
  console.log(t.qualifiedName, t.columns.map(c => c.name));
  console.log('  enums:', [...model.enums.keys()]);
}
```

`PhysicalModel` 的形状见 `packages/core/src/projector/types.ts`。

### 14.4 部分加载

```typescript
await load({ fs, basePath, systemFilter: ['base'] });   // 只加载 base 系统
```

适合增量场景或部分投影。

---

## 第 15 章 CI / Git 集成

### 15.1 GitHub Actions

```yaml
# .github/workflows/schema-check.yml
name: schema-check
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r run build
      - run: node packages/cli/bin/loom check systems/
      - run: |
          node packages/cli/bin/loom project sql --dialect pg systems/ > /tmp/schema.sql
          git diff --exit-code /tmp/schema.sql || \
            (echo "projected SQL drift detected; commit the regenerated artifact" && exit 1)
```

### 15.2 pre-commit hook（计划）

`loom fmt`（未实现）+ `loom check` 跑在 pre-commit，保证提交的 schema 始终
diff-stable 且引用完整。

### 15.3 diff-stability 契约

投影器**确定性**——同样的输入产出字节级一致的输出。这样：

- design schema diff → 物理 schema diff，可预测
- 重新投影 → 物理 schema 不变（除非真的有语义变更）

黄金固件测试（`packages/core/tests/golden/*.sql`）锁定这条契约，
任何会改变 SQL 生成的改动都会被回归线抓住。

---

## 第 16 章 已知局限与路线

### 16.1 v0.2.0 已知局限

| 项 | 说明 |
|---|---|
| 诊断无行号 | 错误硬编码为 `1:1`，YAML 位置追踪未实现 |
| FK 渲染原始 | `foreign_keys.ref_table` 原样输出，`entity:` refs 不解析为 `primary_table` |
| 形态 C 重命名未实现 | using 仅支持 A（`ns.*`）与 B（`ns.Name`）；冲突时用全限定名绕开 |
| mixin using 化未实现 | mixin include 仍用 `- include: mixin:...`（v2.1 候选） |
| 未实现的命令 | `fmt`（格式化）、`lift`（反向提炼）、`project atlas-yaml` |

### 16.2 后续路线

- YAML 位置追踪 → 精确 line:col 诊断
- FK 跨 kind 解析（`entity:` → `primary_table`）
- using 形态 C（重命名）——解决短名冲突，无需回退全限定名
- mixin using 化——把 `- include: mixin:...` 纳入 using 体系（v2.1 候选）
- 共享目录候选——v0.2.0 取消了 `_shared/`，所有 kind 落模块目录；若实践中跨模块
  复用频繁、需要"位置即意图"的强提示，可重新引入 `_shared/` 作为可选风格
  （思路见 `docs/design/2026-06-18-shared-and-value-type-notes.md` §a）
- 方言插件机制——支持注册第三方 `dialects/<name>.ts`（达梦、OceanBase 等），
  而非在 schema 里描述方言映射（同上设计文档 §c 已否决 schema 自描述方案）
- `loom fmt` — 字段排序、key 顺序固定、缩进统一
- `loom lift` — 从 atlas-yaml/v2 物理格式反向提炼 design schema 骨架
- `loom project atlas-yaml` — 桥接到 atlas 生态
- `loom project prisma` / `loom project openapi`（更后续）

---

## 附录 A 完整工作示例

下面是仓库 `packages/core/tests/fixtures/base_schema.ts` 中的完整 schema，
对应黄金固件 `base_schema.pg.sql` 的输出。

### A.1 base_types.yaml

```yaml
version: loom-schema/v2
kind: base_types
scalars:
  - { name: bigint,   description: 64-bit integer, properties: [] }
  - name: decimal
    description: fixed-point
    properties:
      - { name: precision, type: integer, required: true }
      - { name: scale, type: integer, required: true }
  - name: string
    description: var-length string
    properties:
      - { name: max_length, type: integer, required: true }
      - { name: pattern, type: string }
  - { name: datetime, description: timestamp, properties: [] }
  - { name: boolean,  description: boolean,   properties: [] }
```

### A.2 systems/base/core/MANIFEST.yaml

```yaml
version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
description: core module
```

### A.3 systems/base/core/mixin/audit.yaml

```yaml
version: loom-schema/v2
kind: mixin
name: Audit
fields:
  - { name: created_at, type: datetime, required: true }
  - { name: updated_at, type: datetime, required: true }
```

### A.4 systems/base/core/value_type/email.yaml + money.yaml

```yaml
# email.yaml
version: loom-schema/v2
kind: value_type
name: Email
fields:
  - { name: value, type: string, max_length: 254 }
```

```yaml
# money.yaml
version: loom-schema/v2
kind: value_type
name: Money
fields:
  - { name: amount,        type: decimal, precision: 18, scale: 4, required: true }
  - { name: currency_code, type: string,  max_length: 3, required: true }
```

### A.5 systems/base/core/table/users.yaml

```yaml
version: loom-schema/v2
kind: table
name: Users
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - { name: id, type: bigint, required: true }
  - include: mixin:base.core.Audit
  - name: email
    type: base.core.Email
    required: true
    unique: true
  - name: balance
    type: base.core.Money
primary_key: [id]
indexes:
  - { name: idx_users_email, fields: [email], unique: true }
```

### A.6 systems/base/core/entity/user.yaml

```yaml
version: loom-schema/v2
kind: entity
name: User
primary_table: table:base.core.Users
business_keys: [email]
audit: true
```

### A.7 systems/base/core/extension/user_fields.yaml

```yaml
version: loom-schema/v2
kind: extension_fields
entity: entity:base.core.User
fields:
  - { name: nickname, type: string, max_length: 50, default_scope: tenant }
```

### A.8 投影输出（PG）

```sql
CREATE TABLE base_core.users_base (
  id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  balance_amount NUMERIC(18,4),
  balance_currency_code VARCHAR(3),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX idx_users_email ON base_core.users_base (email);

CREATE TABLE base_core.users_ext (
  base_id BIGINT NOT NULL,
  tenant_id BIGINT,
  field_name VARCHAR(100) NOT NULL,
  data_type VARCHAR(20) NOT NULL,
  int_value BIGINT,
  decimal_value NUMERIC(18,4),
  string_value TEXT,
  datetime_value TIMESTAMPTZ,
  boolean_value BOOLEAN,
  json_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE VIEW users AS
SELECT
  id,
  created_at,
  updated_at,
  email,
  balance_amount,
  balance_currency_code,
  (SELECT string_value FROM users_ext e
   WHERE e.base_id = u.id AND e.field_name = 'nickname' LIMIT 1) AS nickname
FROM base_core.users_base u;
```

---

## 附录 B 错误类别速查

| 类别 | 触发场景 |
|---|---|
| `parse` | YAML 语法错、字段类型错 |
| `version` | version 字段不匹配 |
| `identity` | 路径与文件内自指冲突、identity 重复 |
| `dangling_ref` | `$ref` 目标不存在 |
| `kind_mismatch` | `$ref` 目标 kind 与上下文期望不符 |
| `cycle` | mixin 互相 include 形成环 |
| `schema` | field 缺 `type:`、类型解析失败、属性不在 scalar 的 properties schema 内 |
| `semantic` | primary_key 字段非 required、extension_fields 目标 entity 不存在或非 sidecar_eav |
| `project` | 投影器无法落到目标方言 |

---

**更多设计细节**：参见 `docs/specs/2026-06-17-loom-design.md`（v1 完整设计规范）。
**v2 类型系统设计**：参见 `docs/specs/2026-06-18-loom-v2-type-system.md`
（统一 `type:` 键与 `using` 导入机制的设计文档）。
**v2 实现计划**：参见 `docs/superpowers/plans/2026-06-18-loom-v2.md`（v2 15 任务拆解）。
