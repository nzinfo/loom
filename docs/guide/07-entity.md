# entity：业务身份层

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
view: users                              # 可选：逻辑视图名（sidecar_eav 时创建 view）
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

## physical_schema：投影期派生（无 manifest 文件）

物理 schema 空间（PG schema / MySQL database）是**投影期决策**，不是逻辑模型的一部分。
loom 不再有 `module_manifest` 文件——physical_schema 在投影时从模块路径**派生**：

```
base.core   → base_core        (<system>_<module>)
retail.pos  → retail_pos
retail.types → retail_types
```

### 自定义物理 schema：CLI `--physical-schema` 覆盖

如果派生名不满足需求（如 ext 包要隔离到独立 schema），用 `loom project` 的
`--physical-schema` 覆盖（可重复）：

```sh
loom project sql --dialect pg \
  --physical-schema retail.pos=acme_retail_pos \
  my-schema/
```

覆盖以模块 fqn 为键（`retail.pos`），替换派生名。

### 为什么不再用 manifest 文件

`module_manifest` 原本承载 physical_schema，但它本质是投影期配置，不是逻辑声明：
- schema 描述"业务长什么样"，physical_schema 描述"落到哪个物理库"——两件事
- manifest 唯一实际被消费的字段就是 physical_schema，其余（system/module/exports）要么
  路径已推导、要么未实现
- 派生 + CLI 覆盖覆盖了全部真实用例，省掉一个 kind + N 个文件

如果未来 physical_schema 配置变复杂（命名策略、多方言偏好等），再引入一个投影期
配置文件（`loom.config.yaml`）作为默认来源——届时它会有多个字段撑着，引入代价才划算。
当前 CLI 覆盖已足够。
