# entity 与 module_manifest

## entity：业务身份层

`table` 承载物理结构 + 扩展策略；`entity` 在 table 之上加**业务身份**：

```yaml
# platform/base/core/user.entity.yaml
version: loom-schema/v2
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
- `primary_table:` 是**身份引用**，保留 `table:` kind 前缀（详见 [09 refs](./09-refs.md)）
- v2 投影时 entity 不直接投影，只通过 primary_table 投影

### entity 的真正价值：被 extension_fields 锚定

entity 不只是"业务元数据容器"。它是 extension_fields 的**锚点**——所有扩展字段
（platform / ext / tenant 都可以写）都挂在 entity 身上：

```yaml
# platform 写：platform/base/core/user_fields.ext.yaml
# tenant 写：tenants/acme/base/core/user_fields.ext.yaml
entity: entity:base.core.User           # ← 锚点
fields:
  - { name: nickname, ... }
```

详见 [08 extension_fields](./08-extension-fields.md)。

### 谁能定义 entity

- **platform**：权威定义
- **ext**：可独立定义自己的 entity（与 platform 不撞名）
- **tenant**：**不能**定义 entity——tenant 层只能给已存在的 entity 写 extension_fields

详见 [01 目录与身份](./01-layout-and-identity.md) §owner 维度。

---

## module_manifest：physical_schema 归属

物理 schema 空间（PG schema / MySQL database）是**模块级别决策**，不该 per-table 配置：

```yaml
# platform/base/core/manifest.module.yaml
version: loom-schema/v2
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

### ext 包的 MANIFEST

ext 包（`ext/<provider>/<sys>/<mod>/`）也有自己的 MANIFEST，声明独立的
`physical_schema`。这让 ext 的物理表落在独立 schema 里，与 platform 隔离：

```yaml
# ext/acme-corp/retail/pos/manifest.module.yaml
version: loom-schema/v2
system: retail
module: pos
physical_schema: acme_retail_pos          # ext 自己的 schema
description: acme-corp retail POS extension
```
