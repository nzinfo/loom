# 目录结构与身份约定

loom 最核心的设计是**"路径即身份 + 路径即归属"**：你不需要在文件头声明
system/module/kind/name，它们直接由文件路径推导；同样，节点归属于哪一层 owner
（平台 / 第三方扩展 / 租户）也由路径的顶层前缀决定。

## 标准布局（v2 owner 维度）

loom v2 把目录树组织成三层 owner 前缀：

```
my-schema/
├── platform/                            # 平台内置（权威定义）
│   └── base/
│       └── core/
│           ├── base_types.yaml          # 全局唯一，可用标量目录
│           ├── MANIFEST.yaml            # kind: module_manifest
│           ├── value_type/
│           ├── mixin/
│           ├── table/
│           ├── entity/
│           └── extension/
│               └── <name>_fields.yaml   # kind: extension_fields
├── ext/                                 # 第三方扩展包（独立作者）
│   └── <provider>/                      # 如 acme-corp
│       └── <system>/
│           └── <module>/
│               ├── MANIFEST.yaml
│               ├── value_type/ mixin/ table/ entity/ extension/
└── tenants/                             # 租户定制（仅扩展字段）
    └── <tenant-id>/                     # 如 acme
        └── <system>/
            └── <module>/
                └── <name>_fields.yaml   # 仅 extension_fields，无 kind 目录
```

**三层 owner 固定枚举**（详见 `docs/specs/2026-06-18-loom-v2-owner-dimension.md`）：

| owner | 目录前缀 | 能力 | 典型场景 |
|---|---|---|---|
| **platform** | `platform/<sys>/<mod>/` | 全部 kind + base_types + module_manifest | 平台权威定义 |
| **ext** | `ext/<provider>/<sys>/<mod>/` | 除 base_types 外全部 kind | 第三方扩展包 |
| **tenant** | `tenants/<id>/<sys>/<mod>/` | **仅** extension_fields（无 kind 子目录） | 租户级字段定制 |

## 路径推导身份与 owner

```
platform/base/core/entity/user.yaml
└owner──┘ └system┘ └module┘ └kind┘ └name┘
=> identity = entity:base.core.User
=> owner    = platform

ext/acme-corp/retail/pos/table/orders.yaml
└owner────────┘ └system─┘ └mod─┘ └kind┘ └name┘
=> identity = table:retail.pos.Orders
=> owner    = ext:acme-corp

tenants/acme/base/core/user_fields.yaml
└owner───────┘ └tenant─┘ └system┘ └module┘ └name──────┘
=> identity = extension_fields:base.core.User_fields
=> owner    = tenant:acme
```

identity 仍是 `kind:sys.mod.Name` 三段不变；owner 是节点的独立字段，从路径顶层
前缀推断，**不在文件内容里声明**。跨 owner 引用是隐式的——ref 不带 owner，
全局查表（spec §4）。

## 关键规则

- 目录/文件名用 **kebab-case**（`user-profile.yaml`）
- 推导出的逻辑名转 **PascalCase**（`user` → `User`，`user-profile` → `UserProfile`）
- `extension/` 目录映射到 `extension_fields` kind（不对称，唯一例外）
- 物理表名在 `table.name` 字段显式声明（不依赖推导）
- `base_types.yaml` 唯一合法位置：`platform/base/core/base_types.yaml`（全局共享）
- tenant 目录无 kind 子目录——tenant 层只有 extension_fields 一种 kind

## 撞名规则与扩展叠加

- **节点 identity 全局唯一**：两个不同路径推导出同一 identity（且非 extension_fields）
  → discovery 阶段报 `duplicate identity` 错误
- **extension_fields 例外**：多个 owner 可给同一 entity 写 extension_fields，**叠加**
  （并集），不视为撞名。最终该 entity 的扩展字段 = 各 owner 声明的并集
- **同名扩展字段冲突**：两个 owner 都声明了同名字段（如都写 `tax_id`）→ 报错，
  不覆盖、不合并、不按优先级取舍

详见 [08 extension_fields](./08-extension-fields.md)。

## 文件头格式

每个文件顶格两行：

```yaml
version: loom-schema/v2
kind: <entity | table | value_type | mixin | module_manifest | extension_fields | base_types>
# 之后是该 kind 的内容
```

`version` 是 wire 版本号，破坏性变更必须 bump。reader 严格匹配。
v2（`loom-schema/v2`）引入统一 `type:` 键与 `using` 导入机制，不兼容 v1（详见
`docs/specs/2026-06-18-loom-v2-type-system.md`）。

owner **不写在文件里**——它从路径推断。文件头只有 `version` 和 `kind`。
