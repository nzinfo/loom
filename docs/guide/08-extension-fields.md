# extension_fields：自定义字段模板

EAV 表完全动态会带来隐患（任意字段都能加）。`extension_fields` 文件**预声明**
"允许哪些自定义字段、什么类型"，作为运行时校验和 view 生成的依据。

## 定义模板

```yaml
# platform/base/core/user_fields.ext.yaml
version: loom-schema/v2
entity: entity:base.core.User           # 作用于哪个 entity（身份引用，kind 前缀保留）
fields:
  - name: nickname
    type:
      ref: string
      args: { max_length: 50 }
    default_scope: tenant              # 租户级自定义
  - name: credit_limit
    type: base.core.Money              # 多字段 value_type 也能用
    default_scope: tenant
  - name: customer_grade
    type: base.core.CustomerGrade      # variants 形态的 value_type（详见 06-table §variants）
    default_scope: tenant
```

## 为什么独立文件

自定义字段是**部署/配置期**产物（不同租户、不同项目不同），生命周期与
entity/table（开发期）不同。混在一起，diff 会被频繁的部署配置搅乱。
单独的 `extension/` 目录便于工具扫描与租户级差异管理。

## 多 owner 叠加（核心特性）

extension_fields 是 loom owner 维度的关键应用场景。多个 owner 可以给同一个
entity 写 extension_fields，加载器**收集所有**并叠加。最终该 entity 的扩展字段
= 各 owner 声明的字段的并集。

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

### 同名字段冲突 = 硬错误

如果两个 owner 都声明了同名字段（如都写 `tax_id`），加载器**报错**，
不覆盖、不合并、不按优先级取舍：

```
ext:acme-corp 的 user_fields: [tax_id]
tenant:acme 的 user_fields:    [tax_id]
→ ❌ 报错：duplicate extension field "tax_id" on entity entity:base.core.User
```

简单、无歧义、无 merge 算法。

### 为什么不进 nodes map

extension_fields 是"针对某 entity 的附加配置"，不是节点定义。多个 owner 写相同
identity 是正常形态（platform / ext / tenant 都给同一 entity 加字段）。所以
extension_fields 不进入 IR 的 nodes map（避免与节点定义的 identity 唯一性规则混淆），
而是在 link 阶段收集到一个独立 registry：`IR.extensionFields`（按 entity identity
分桶）。详见 [11 加载管线](./11-pipeline.md)。

## view 中的展开

模板里声明的每个字段都会在 view 里展开成虚拟列。多字段 value_type（如 Money）
会展开成多个虚拟列（`credit_limit_amount`、`credit_limit_currency_code`）。

多 owner 叠加的字段都会在同一张 view 里展开。例如 platform 的 `nickname` 和
tenant:acme 的 `customer_no` 都进 `users` view：

```sql
CREATE VIEW users AS
SELECT
  id, email, ...,
  (SELECT string_value FROM users_ext e WHERE e.base_id = u.id AND e.field_name = 'nickname' LIMIT 1) AS nickname,
  (SELECT string_value FROM users_ext e WHERE e.base_id = u.id AND e.field_name = 'customer_no' LIMIT 1) AS customer_no
FROM base_core.users_base u;
```

## 谁能写 extension_fields

| owner | 能写 extension_fields? | 路径 |
|---|---|---|
| **platform** | ✓ | `platform/<sys>/<mod>/extension/<name>_fields.yaml` |
| **ext** | ✓ | `ext/<provider>/<sys>/<mod>/extension/<name>_fields.yaml` |
| **tenant** | ✓（这是 tenant 唯一能写的 kind） | `tenants/<id>/<sys>/<mod>/<name>_fields.yaml`（无 kind 子目录） |

详见 [01 目录与身份](./01-layout-and-identity.md) §owner 维度。
