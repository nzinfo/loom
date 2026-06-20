# loom v2：owner 维度——platform / ext / tenant 三层归属

- **状态**：设计讨论稿（待 review → 转 writing-plans）
- **日期**：2026-06-18
- **作者**：nzinfo + Claude
- **关联文档**：
  - `docs/specs/2026-06-18-loom-v2-type-system.md`：v2 类型系统（本文档在其之上叠加 owner 维度）
  - `docs/specs/2026-06-17-loom-design.md`：v1 完整设计
- **格式版本**：仍为 `loom-schema/v2`（**不 bump version**，owner 维度是 v2 内的能力扩展）

## 0. 摘要

当前 v2 的所有节点共享一个扁平名字空间——identity `kind:sys.mod.Name` 不区分节点的
"出处"。这在 ERP 场景下不够：需要区分**平台内置**（platform）、**第三方扩展包**
（ext）和**租户定制**（tenant）三层归属，让不同来源的 schema 各有边界、互不污染。

本设计引入 **owner 维度**——一个独立于 identity 的节点属性，表达"这个节点是谁提供
的"。三层 owner 语义明确：

- **platform**：平台内置，权威定义
- **ext:&lt;provider&gt;**：第三方扩展包，独立开发者，能完整建表/类型，但名字不可与
  platform 或其他 ext 撞
- **tenant:&lt;id&gt;**：租户定制，只对 entity 挂 extension_fields，不建任何节点

**一句话**：identity 仍是 `kind:sys.mod.Name`（三段不变）；owner 是节点的独立字段，
从目录路径推断；扩展全部走现有 `extension_fields` + sidecar_eav 机制，**无 extends
关键字、无 merge 算法**。

## 1. 背景：为什么需要 owner 维度

### 1.1 ERP 的三层结构

ERP 系统里有两层概念：

```
┌─────────────────────────────────────┐
│  数据表 (data table)                 │  ← 平台定义，不可动
│  users_base: id, email, created_at  │
├─────────────────────────────────────┤
│  扩展表 (extension table)            │  ← sidecar EAV，存扩展字段值
│  users_ext: base_id, field_name,    │
│             string_value, ...       │
├─────────────────────────────────────┤
│  实体 (entity)                       │  ← 业务身份 + 扩展配置层
│  User:                               │
│    primary_table: users_base        │
│    extension_fields: [nickname,     │
│                       tax_id]       │
└─────────────────────────────────────┘
```

对应到 loom 已有的机制：

| ERP 概念 | loom 实现 |
|---|---|
| 数据表 | `kind: table`（strategy: none / json_column / sidecar_eav） |
| 扩展表 | sidecar_eav 策略下自动生成的 `_ext` 表 |
| 实体 | `kind: entity` + `kind: extension_fields`（扩展字段模板） |

**关键洞察**：loom 的扩展机制（entity + extension_fields + sidecar_eav）已经完备。
owner 维度不是"增加新的扩展能力"，而是**给现有机制加归属边界**——让 platform/ext/
tenant 的 schema 各自有目录、有身份、有撞名检测。

### 1.2 当前 v2 的不足

- 所有节点共享扁平名字空间，platform 的 `base.core.Users` 和某 ext 包想定义的
  `base.core.Users` 无法区分——撞名即冲突，没有"这是我的扩展"的表达
- `default_scope: tenant` 是死元数据（schema 声明了但 projector 不消费）
- `tenant_id` 在方言层硬编码（pg.ts 无条件生成 `tenant_id BIGINT`），与 schema 无关
- 没有目录层的归属隔离——所有文件混在 `systems/<sys>/<mod>/` 下

### 1.3 设计原则

- **不破坏 identity**：identity 三段不变，owner 是独立字段
- **不引入 merge**：扩展全部走 extension_fields，无 extends、无字段级合并
- **目录即归属**：owner 从路径推断，文件内不必重复声明
- **最小破坏**：仍为 v2，不 bump version；现有 schema 需迁移目录但语义不变

## 2. owner 三层语义

### 2.1 platform

- **角色**：平台内置，权威定义
- **能力**：定义所有 kind（base_types / module_manifest / value_type / mixin / table /
  entity / extension_fields）
- **base_types 归属**：`base.types.yaml` 唯一位置在 `platform/base/core/`，全局共享
- **目录**：`platform/<sys>/<mod>/`

### 2.2 ext:&lt;provider&gt;

- **角色**：第三方扩展包，独立开发者
- **能力**：完整定义 table / value_type / mixin / entity / extension_fields（除
  base_types / module_manifest 受限——见下）
- **撞名规则**：节点 identity 全局唯一——ext 定义的新节点不可与 platform 或其他 ext
  的节点撞名
- **module_manifest**：ext 包仍需写 `manifest.module.yaml`（声明 physical_schema 等），owner
  字段为 `ext:<provider>`
- **base_types**：ext **不能**定义 base_types（标量是全局词汇，只由 platform 提供）
- **目录**：`ext/<provider>/<sys>/<mod>/`
- **跨 owner 引用**：隐式（ref 不带 owner，按 sys.mod.Name 全局查表；名字唯一保证
  无歧义）

```yaml
# ext/acme-corp/retail/pos/orders.table.yaml
version: loom-schema/v2
name: Orders
table:
  name: orders
  extension:
    strategy: none
fields:
  - name: id
    type: bigint
    required: true
  - name: user_id
    type: bigint
    required: true
foreign_keys:
  - name: fk_user
    fields: [user_id]
    ref_table: base.core.Users       # 隐式引用 platform 的 Users（不带 owner）
primary_key: [id]
```

### 2.3 tenant:&lt;id&gt;

- **角色**：租户定制，只配置不定义
- **能力**：**仅** `kind: extension_fields`——给已存在的 entity 挂扩展字段模板
- **不能**：建 table / value_type / mixin / entity / base_types / module_manifest
- **目录**：`tenants/<tenant-id>/<sys>/<mod>/<name>_fields.ext.yaml`（tenant 层
  只有 extension_fields 一种 kind，扩展名即 `.ext.yaml`）
- **entity 字段**：必须指向已存在的 entity（platform 或 ext 定义的）；指向不存在
  的 entity 报错

```yaml
# tenants/acme/base/core/user_fields.ext.yaml
version: loom-schema/v2
entity: entity:base.core.User        # 必须指向已存在的 entity
fields:
  - name: nickname
    type: { ref: string, args: { max_length: 50 } }
    default_scope: tenant
  - name: tax_id
    type: { ref: string, args: { max_length: 20 } }
```

### 2.4 owner 枚举

固定三类，schema 严格校验：

| owner 形式 | 含义 | 示例 |
|---|---|---|
| `platform` | 平台内置 | `platform` |
| `ext:<provider>` | 扩展包，provider 一段 | `ext:acme-corp`、`ext:sap` |
| `tenant:<id>` | 租户定制 | `tenant:acme`、`tenant:globex` |

不允许其他形式（如 `org:*` / `user:*`）——v2 严格枚举，未来需要再扩展。

## 3. 目录布局

### 3.1 总览

布局是**扁平**的——没有 kind 子目录（`value_type/`、`mixin/` 等），kind 完全由
文件扩展名编码（`.entity.yaml`、`.table.yaml`、`.value_type.yaml`、`.mixin.yaml`、
`.ext.yaml`、`.types.yaml`、`.module.yaml`）：

```
my-schema/
├── platform/                              # 平台内置
│   └── <sys>/<mod>/
│       ├── manifest.module.yaml           # kind: module_manifest
│       ├── base.types.yaml                # 仅 platform/base/core/ 有，全局共享
│       ├── email.value_type.yaml          # kind 由扩展名决定
│       ├── users.table.yaml
│       └── user.entity.yaml
├── ext/                                   # 扩展包集合
│   └── <provider>/                        # 提供者
│       └── <sys>/<mod>/                   # 独立命名空间
│           ├── manifest.module.yaml
│           ├── orders.table.yaml
│           └── user_fields.ext.yaml       # kind: extension_fields
└── tenants/                               # 租户集合
    └── <tenant-id>/                       # 租户
        └── <sys>/<mod>/<name>_fields.ext.yaml   # 仅 extension_fields
```

> **三种 owner 用相同的扩展名机制**：platform / ext / tenant 都用 `.ext.yaml`
> 表达 extension_fields，区别只在 owner 前缀。tenant 层只允许 `.ext.yaml`，
> 不允许其它 kind。

### 3.2 关键规则

- **platform 下直接 `<sys>/<mod>/`**——无 `systems/` 中间层
- **ext 下是 provider → sys/mod**——provider 一级，sys/mod 两级，共三级
- **tenants 下是 tenant-id → sys/mod**——tenant 层只有 extension_fields 一种
  kind（`.ext.yaml`），路径镜像目标 entity 的 sys/mod
- **kind 由扩展名决定**：`.entity.yaml` / `.table.yaml` / `.value_type.yaml` /
  `.mixin.yaml` / `.ext.yaml` / `.types.yaml` / `.module.yaml`，文件正文不写 `kind:`
- **base.types.yaml 唯一位置**：`platform/base/core/base.types.yaml`，全局共享
- **文件名 `_fields` 后缀**：extension_fields 文件沿用约定（`user_fields.ext.yaml`），
  `.ext.yaml` 扩展名即 kind 标识

## 4. 身份编码

### 4.1 identity 不变

- 格式仍为 `<kind>:<sys>.<module>.<PascalName>`（三段，无 owner）
- base_types 身份仍为 `base_types:base.core`
- 所有 ref（type 引用、entity 引用、foreign_keys、include 等）不带 owner

### 4.2 owner 是节点独立字段

IR 节点新增 `owner` 字段，从目录路径推断，不在文件内声明：

```typescript
// ir/version.ts
export type IRNode = AnyFile & {
  readonly identity: Identity;
  readonly owner: Owner;          // 新增
};

export type Owner =
  | { kind: 'platform' }
  | { kind: 'ext'; provider: string }
  | { kind: 'tenant'; id: string };
```

IR 的 nodes map 仍以 identity 为键（不变）；owner 作为节点的属性查询。

### 4.3 owner 从路径推断

pathToIdentity 扩展为同时返回 owner：

| 路径前缀 | owner |
|---|---|
| `platform/<sys>/<mod>/...` | `platform` |
| `ext/<provider>/<sys>/<mod>/...` | `ext:<provider>` |
| `tenants/<id>/<sys>/<mod>/...` | `tenant:<id>` |
| 其他（根目录散文件等） | 报 `identity` 错误 |

### 4.4 跨 owner 引用（隐式）

所有 ref **不带 owner**，加载器按 `sys.mod.Name` 全局查表：

```yaml
# ext:acme-corp 的 Orders 引用 platform 的 Users
foreign_keys:
  - name: fk_user
    ref_table: base.core.Users       # 不带 owner
```

名字全局唯一（撞名检测保证）→ 隐式引用总能命中唯一节点。无歧义。

## 5. 撞名检测

### 5.1 规则

identity 全局唯一——**跨 owner 撞名即冲突**：

```
platform/base/core/users.table.yaml   → table:base.core.Users (owner: platform)
ext/acme-corp/base/core/users.table.yaml → table:base.core.Users (owner: ext:acme-corp)
```

这两个文件都试图定义 `table:base.core.Users`，加载器在 discovery 阶段检测到
identity 重复，报 `duplicate identity` 错误。

### 5.2 ext 的命名空间策略

ext 的 `<sys>/<mod>` **可以与 platform 的 sys/mod 同名**（如 ext:acme-corp 也有
`base/core/`）——这表达"这是对 platform 该命名空间的关注/配套"。但**节点名字不可
撞**：

- ext:acme-corp 在 `base/core/` 下定义 `Orders`（新名字）→ ✅ 合法
- ext:acme-corp 在 `base/core/` 下定义 `Users`（撞 platform）→ ❌ 报错

想给 platform 的 entity 加字段，走 extension_fields（见 §6），不重定义节点。

### 5.3 检测时机

discovery 阶段（Pass 0）即检测——两个文件路径不同但 pathToIdentity 产出相同
identity 时立即报错，不等 link/validate。

## 6. 扩展机制（无 extends、无 merge）

### 6.1 设计决策

**不引入 extends 关键字、不实现字段级 merge 算法**。所有"扩展"走现有
`extension_fields` + sidecar_eav 机制：

- platform 定义 table（含 extension strategy）+ entity
- ext/tenant 给 entity 写 extension_fields（声明扩展字段模板）
- 物理实现：扩展字段值存进 sidecar EAV 表（users_ext）

这与 loom 当前机制完全一致——owner 维度只是给 extension_fields 加了归属目录，不
改变其语义。

### 6.2 为什么不要 extends

- **避免 merge 算法复杂度**：字段级 merge 要定义"能加什么/能改什么/能删什么/冲突
  怎么办"，是 v2 不该背的包袱
- **与 ERP 模型一致**：数据表由定义方一次写完，扩展走 EAV（运行时灵活、不锁表结构）
- **现有机制已够用**：extension_fields + sidecar_eav 已经能表达"给 entity 加字段"

### 6.3 ext/tenant 都能写 extension_fields（叠加，同名报错）

多个 owner 可以给同一个 entity 写 extension_fields，加载器**收集所有**并叠加。
最终该 entity 的扩展字段 = 各 owner 声明的字段的并集。

```yaml
# ext:acme-corp 给 platform 的 User entity 挂扩展字段
# ext/acme-corp/base/core/user_fields.ext.yaml
entity: entity:base.core.User
fields:
  - name: tax_id
    type: { ref: string, args: { max_length: 20 } }

# tenant:acme 给同一个 entity 挂另一组扩展字段
# tenants/acme/base/core/user_fields.ext.yaml
entity: entity:base.core.User
fields:
  - name: nickname
    type: { ref: string, args: { max_length: 50 } }
    default_scope: tenant
```

叠加结果：User 的扩展字段 = `{ tax_id, nickname }`，都进 EAV pivot view。

**同名字段冲突报错**：如果两个 owner 都声明了同名字段（如都写 `tax_id`），加载器
报错，不覆盖、不合并、不按优先级取舍。

```
ext:acme-corp 的 user_fields: [tax_id]
tenant:acme 的 user_fields:    [tax_id]
→ ❌ 报错：duplicate extension field "tax_id" on entity base.core.User
```

简单、无歧义、无 merge 算法。

## 7. extension_fields 的聚合设计

### 7.1 设计意图：按 entity 叠加

extension_fields 不是"定义节点"，而是"针对某 entity 的附加配置"。多个 owner
（ext、tenant）天然会给同一个 entity 写不同的扩展字段——这是 ERP 扩展模型的正常
形态：

```
platform 定义 entity:base.core.User（业务身份）
ext:acme-corp 给 User 加 tax_id（行业扩展字段）
tenant:acme 给 User 加 nickname（租户定制字段）
tenant:globex 给 User 加 customer_no（另一租户定制）
```

这些 extension_fields 文件**不是冲突**，而是**叠加**——最终 User 的扩展字段集合
是所有 owner 声明的并集。

### 7.2 不进 nodes map，进独立 registry

因为 extension_fields 是"附加配置"而非"节点定义"，它不进入 IR 的 nodes map
（避免与节点定义的 identity 唯一性规则混淆）。改为在 link 阶段收集所有
extension_fields 文件，按 **entity identity** 聚合到独立的 registry：

```typescript
// IR 新增
extensionFields: ReadonlyMap<Identity, ReadonlyArray<ExtensionFieldEntry>>
//                  ↑ entity id      ↑ 所有 owner 声明的字段并集
```

- discovery 仍为每个 extension_fields 文件计算 identity（用于 diagnostics 定位）
- nodes map 不存 extension_fields（它不是定义节点）
- collectExtensionFields 遍历所有 parsed 文件，按 entity 字段聚合

### 7.3 同名字段冲突检测

聚合时按字段名去重——如果两个 owner 声明了同名字段，报错：

```
ext:acme-corp 的 user_fields: [tax_id]
tenant:acme 的 user_fields:    [tax_id]
→ ❌ duplicate extension field "tax_id" on entity base.core.User
```

冲突信息包含：字段名、entity identity、两个来源（owner + 文件路径），方便定位。

### 7.4 文件命名自由

由于 extension_fields 不进 nodes map，文件名只需在**同一 owner 内**不重复，
跨 owner 可以同名：

```
ext/acme-corp/base/core/user_fields.ext.yaml    # ext:acme-corp 的
tenants/acme/base/core/user_fields.ext.yaml     # tenant:acme 的
tenants/globex/base/core/user_fields.ext.yaml   # tenant:globex 的
```

三个文件 stem 相同（`user_fields`）、都在 `base/core/` 下、但 owner 不同，各自
合法。加载器按 entity 聚合时不关心文件名，只看 entity 字段 + 字段声明。

## 8. base_types 的归属

### 8.1 唯一位置

`base.types.yaml` 全局唯一，位置固定在 `platform/base/core/base.types.yaml`。

- 身份仍为 `base_types:base.core`（不变）
- owner 为 `platform`
- **全局共享**：ext/tenant 隐式依赖 platform 的 base_types

### 8.2 标量短名解析

`integer`、`string` 等短名仍走默认 `base.core.*` 导入（v2 类型系统机制不变）。
base_types 的物理位置变化不影响短名解析——加载器仍从 IR 的 base_types 节点读 scalars
数组。

### 8.3 ext/tenant 不能定义 base_types

discovery 阶段检测：`base.types.yaml` 只能出现在 `platform/base/core/` 下。其他位置
出现 base_types 文件报错。

## 9. manifest.module.yaml 与 owner

### 9.1 module_manifest 仍按模块写

platform 和 ext 的每个 `<sys>/<mod>/` 都有自己的 `manifest.module.yaml`（声明
physical_schema 等）。tenant 不需要 module_manifest（它不定义模块）。

### 9.2 owner 不在 module_manifest 里声明

owner 从**目录路径**推断（platform/ vs ext/&lt;provider&gt;/ vs tenants/&lt;id&gt;/），
不在 `manifest.module.yaml` 里写 owner 字段。避免文件内容与路径位置不一致。

### 9.3 physical_schema 的命名空间

physical_schema 仍按现有规则（如 `base_core`）。ext 包的 physical_schema 由 ext
自己命名（如 `acme_retail_pos`），与 platform 不撞。投影时按 physical_schema
分 schema。

## 10. IR 与加载管线的影响

### 10.1 IR 扩展

```typescript
export interface IR {
  readonly nodes: ReadonlyMap<Identity, IRNode>;
  readonly deps: ReadonlyMap<Identity, ReadonlySet<Identity>>;
  readonly version: typeof CURRENT_VERSION;
  // 新增：所有 extension_fields 文件按 entity 聚合
  readonly extensionFields: ReadonlyMap<Identity, ReadonlyArray<ExtensionFieldEntry>>;
}

export type IRNode = AnyFile & {
  readonly identity: Identity;
  readonly owner: Owner;          // 新增
};
```

extension_fields 从 nodes map 移出，进独立的 extensionFields map（解决 §7 撞名）。

### 10.2 加载管线改动

| Pass | 改动 |
|---|---|
| discovery | pathToIdentity 解析 owner 前缀；base_types 位置校验；extension_fields 不进 nodes map |
| parse | 不变（Zod schema 不加 owner 字段，owner 是路径派生） |
| link | collectExtensionFields 改为遍历所有 parsed 文件按 entity 聚合；其他不变 |
| validate | 新增：tenant 目录下只能有 extension_fields；base_types 只在 platform/base/core/；extension_fields 的 entity 字段必须存在 |

### 10.3 投影器改动

- `projector/expand.ts`：collectExtensionFields 从 IR.extensionFields 读（而非
  ir.nodes 遍历）
- `projector/views.ts`：buildPivotViews 收集所有 owner 的 extension_fields
- `projector/dialects/`：无改动（registry 结构不变）

## 11. 改动范围（实现预估）

### 11.1 core 包

- **ir/version.ts**：IRNode 加 owner 字段；IR 加 extensionFields map；新增 Owner 类型
- **ir/paths.ts**：pathToIdentity 解析 owner 前缀（platform/ext/tenants）；base_types
  路径校验；extension_fields 路径解析
- **ir/schemas.ts**：无改动（owner 不在 Zod schema 里，是路径派生）
- **loader/discovery.ts**：移除 `systems/` 前缀剥离；按 owner 前缀分流；extension_fields
  不进 nodes map；base_types 位置校验
- **loader/link.ts**：collectExtensionFields 改为遍历 parsed 按 entity 聚合
- **loader/validate.ts**：新增 owner 相关校验（tenant 仅 extension_fields、
  extension_fields.entity 必须存在）
- **projector/expand.ts**：collectExtensionFields 改读 IR.extensionFields
- **projector/views.ts**：无逻辑改动（输入源变化，处理不变）

### 11.2 cli 包

- 无改动（透传 IR）

### 11.3 测试与固件

- `fixtures/base_schema.ts`：目录迁移（systems/ → platform/）；base_types 移入
  platform/base/core/
- 新增 ext 包示例（如 ext:acme-corp 的 retail.pos.Orders）
- 新增 tenant 示例（如 tenant:acme 的 user_fields.ext.yaml）
- 所有路径断言更新（discovery.test、paths.test、loader.test 等）
- golden.test.ts 黄金固件重新生成

### 11.4 文档

- 本 spec 文档
- `docs/USER_GUIDE.md` §2（目录结构）重写；新增 owner 章节
- `docs/design/2026-06-18-owner-dimension-notes.md` 设计记录

## 12. 未决 / 挂起项

| 项 | 状态 | 备注 |
|---|---|---|
| tenant 的 extension_fields 语法细节 | 挂起 | "如何描述实体扩展"后续专门讨论；当前复用现有 extension_fields |
| physical_schema 跨 owner 隔离 | 待定 | ext 的 physical_schema 是否强制与 platform 不同？投影时是否分库？ |
| owner 优先级（投影合并） | 不需要 | 无 merge 机制；各 owner 的 extension_fields 都进 EAV |
| 多 tenant 投影到同一物理库 | 待定 | 当前假设一个 schema = 一个物理库；多租户隔离留待后续 |
| owner 在 diagnostics 里的展示 | 待定 | 错误信息是否带 owner 前缀？ |

## 13. 现状速查

本 spec 描述的 owner 维度已落地，结合后续的 kind-by-extension 改造，当前形态：

| 维度 | 形态 |
|---|---|
| 目录根 | `platform/<sys>/<mod>/`、`ext/<provider>/<sys>/<mod>/`、`tenants/<id>/<sys>/<mod>/` |
| base_types 位置 | `platform/base/core/base.types.yaml`（全局唯一） |
| kind 来源 | 文件扩展名（`.entity.yaml` / `.table.yaml` / `.value_type.yaml` / `.mixin.yaml` / `.ext.yaml` / `.types.yaml` / `.module.yaml`） |
| 布局 | 扁平——无 kind 子目录 |
| identity | `kind:sys.mod.Name` |
| owner | 节点独立字段，三类枚举，从路径推断 |
| 跨 owner 引用 | 隐式（不带 owner） |
| 扩展机制 | extension_fields（`.ext.yaml`）+ sidecar_eav，platform/ext/tenant 三种 owner 共用 |
| extends / merge | 无（明确拒绝） |
| extension_fields 存储 | 独立 `IR.extensionFields` map（按 entity 聚合，不进 nodes map） |

---

**下一步**：本文档 review 通过后，转 writing-plans 拆解为实现计划。
