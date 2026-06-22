# 目录结构与身份约定

loom 最核心的设计是**"路径即身份 + 路径即归属"**：你不需要在文件头声明
system/module/kind/name，它们直接由文件路径推导；同样，节点归属于哪一层 owner
（平台 / 第三方扩展 / 租户）也由路径的顶层前缀决定。

## kind 由文件扩展名编码

**文件的 kind 唯一来源是扩展名**，kind token 在文件名主干与 `.yaml` 之间：

| 扩展名 | kind | 说明 |
|---|---|---|
| `.entity.yaml` | `entity` | 实体 |
| `.table.yaml` | `table` | 表 |
| `.type.yaml` | `type` | 类型定义（scalar/struct/enum 三态，见 [03 type](./03-base-types.md)） |
| `.ext.yaml` | `extension_fields` | 扩展字段（租户/扩展叠加） |

例：`user.entity.yaml`、`orders.table.yaml`、
`email.type.yaml`、`string.type.yaml`、`user_fields.ext.yaml`。

> `type` 是统一的类型定义 kind（scalar/struct/enum 三态，由 `form:` 字段区分），
> 取代了原先的 `base_types`（集合）+ `value_type`（单体）。标量拆成独立文件，
> 不再有 `base.types.yaml` 单例。详见 [03 type](./03-base-types.md)。

文件头只有两行：

```yaml
version: loom-schema/v2
# 之后是该 kind 的内容（无 kind: 行）
```

## 标准布局（v2 owner 维度）

loom v2 把目录树组织成三层 owner 前缀；每个 owner 下，文件**扁平**地放在
`<system>/<module>/` 下，不再有 kind 子目录：

```
my-schema/
├── platform/                            # 平台内置（权威定义）
│   └── base/
│       └── core/
│           ├── bigint.type.yaml         # form: scalar（系统标量，每个一个文件）
│           ├── string.type.yaml
│           ├── email.type.yaml          # form: struct
│           ├── money.type.yaml
│           ├── status.type.yaml         # form: enum
│           ├── users.table.yaml         # kind: table
│           └── user.entity.yaml         # kind: entity
├── ext/                                 # 第三方扩展包（独立作者）
│   └── <provider>/                      # 如 acme-corp
│       └── <system>/
│           └── <module>/
│               ├── orders.table.yaml
│               └── user_fields.ext.yaml # kind: extension_fields
└── tenants/                             # 租户定制（仅扩展字段）
    └── <tenant-id>/                     # 如 acme
        └── <system>/
            └── <module>/
                └── user_fields.ext.yaml # 仅 .ext.yaml，无其它 kind
```

**三层 owner 固定枚举**（详见 [`SPEC.md`](../SPEC.md) §3）：

| owner | 目录前缀 | 能力 | 典型场景 |
|---|---|---|---|
| **platform** | `platform/<sys>/<mod>/` | 全部 kind | 平台权威定义 |
| **ext** | `ext/<provider>/<sys>/<mod>/` | 除 scalar form 外全部 kind | 第三方扩展包 |
| **tenant** | `tenants/<id>/<sys>/<mod>/` | **仅** extension_fields（`.ext.yaml`） | 租户级字段定制 |

## 路径推导身份与 owner

```
platform/base/core/user.entity.yaml
└owner──┘ └system┘ └module┘ └name┘
=> identity = entity:base.core.User
=> owner    = platform

ext/acme-corp/retail/pos/orders.table.yaml
└owner────────┘ └system─┘ └mod─┘ └name───┘
=> identity = table:retail.pos.Orders
=> owner    = ext:acme-corp

tenants/acme/base/core/user_fields.ext.yaml
└owner───────┘ └tenant─┘ └system┘ └module┘ └name──────┘
=> identity = extension_fields:base.core.User_fields
=> owner    = tenant:acme
```

identity 仍是 `kind:sys.mod.Name` 三段不变；owner 是节点的独立字段，从路径顶层
前缀推断，**不在文件内容里声明**。跨 owner 引用是隐式的——ref 不带 owner，
全局查表（spec §4）。

## 关键规则

- 目录/文件名用 **kebab-case**（`user-profile.table.yaml`）
- **身份默认从路径推导**：stem（`user-profile`）→ PascalCase（`UserProfile`）作为
  逻辑名。这是默认值，与大多数 kind 声明的 `name:` 一致
- **声明的 `name:` 覆盖推导**：对 type/table/entity 这类在文件里声明 `name:` 的
  kind，parse 阶段用声明的 name 修正身份（覆盖 stem 推导）。这让 scalar 能用小写名
  （`bigint.type.yaml` 声明 `name: bigint` → 身份 `type:base.core.bigint`，而非 PascalCase
  的 `Bigint`）。路径推导是默认，声明是权威
- **kind 由扩展名决定**——扩展名 token 必须在已知集合内，否则 discovery 报
  `identity` 诊断。文件正文不再写 `kind:`
- 物理表名在 `table.name` 字段显式声明（不依赖推导）
- scalar 类型文件（`*.type.yaml` form: scalar）只在 platform/base/core/ 下——标量是系统基底
- tenant 目录下只能出现 `.ext.yaml` 文件——tenant 层只有 extension_fields 一种 kind

## 撞名规则与扩展叠加

- **节点 identity 全局唯一**：两个不同路径推导出同一 identity（且非 extension_fields）
  → discovery 阶段报 `duplicate identity` 错误
- **extension_fields 例外**：多个 owner 可给同一 entity 写 `.ext.yaml`，**叠加**
  （并集），不视为撞名。最终该 entity 的扩展字段 = 各 owner 声明的并集
- **同名扩展字段冲突**：两个 owner 都声明了同名字段（如都写 `tax_id`）→ 报错，
  不覆盖、不合并、不按优先级取舍

详见 [08 extension_fields](./08-extension-fields.md)。

## 文件头格式

每个文件顶格一行：

```yaml
version: loom-schema/v2
# 之后是该 kind 的内容（kind 由扩展名决定，不写在正文里）
```

`version` 是 wire 版本号，破坏性变更必须 bump。reader 严格匹配。
v2（`loom-schema/v2`）引入统一 `type:` 键与 `using` 导入机制，不兼容 v1（详见
[`SPEC.md`](../SPEC.md) §4）。

owner 与 kind **都不写在文件里**——owner 从路径顶层前缀推断，kind 从扩展名推断。
文件头只有 `version`。
