# extension_fields：自定义字段模板

完全动态的字段会带来隐患（任意字段都能加，无法校验类型）。`extension_fields`
文件**预声明**"允许哪些自定义字段、什么类型、属于哪个组"，作为运行时校验和
view 生成的依据。

预声明的字段不是散落到物理表的列，而是**按组打包**进 sidecar 表的 JSONB 列。
详见 [设计记录：JSONB 扩展组](../design/2026-06-22-jsonb-extension-groups.md)。

## 扩展组（group）

多个扩展字段属于同一个 **group**，打包成 ext 表里的一行 JSONB。组由
`.ext.yaml` 的 `group:` 字段声明（可选，省略时默认 = 文件 stem）。

```yaml
# platform/base/core/user_profile.ext.yaml
version: loom-schema/v2
entity: entity:base.core.User
group: profile
fields:
  - name: nickname
    type:
      ref: string
      args: { max_length: 50 }
  - name: bio
    type: { ref: string, args: { max_length: 500 } }

# platform/base/core/user_finance.ext.yaml
version: loom-schema/v2
entity: entity:base.core.User
group: finance
fields:
  - name: credit_limit
    type: base.core.Money              # 多字段 type（form: struct）也能用
  - name: customer_grade
    type: base.core.CustomerGrade      # form: enum 的 type（详见 06-table §variants）
```

物理上，`profile` 组和 `finance` 组各占 ext 表的一行（每实体 + 每 tenant +
每组一行），组内字段是该行 JSONB 的独立 key：

```
base_id=1, tenant_id=NULL, group_name='profile',
  values='{"nickname":"Alice","bio":"engineer"}'
base_id=1, tenant_id=NULL, group_name='finance',
  values='{"credit_limit_amount":5000,"credit_limit_currency_code":"USD","customer_grade":"vip"}'
```

**分组粒度是文件级**——一个 `.ext.yaml` 文件里所有字段共享同一个 group。所以
行数 = 你划分了多少个文件（组）。把 100 个字段拆到 5 个文件 → 每 entity 每 tenant
5 行；塞进 1 个文件 → 1 行。组划分是作者的主动设计决策。

### 为什么按组而非按字段

扩展字段有两种存储模型。loom 选 JSONB 扩展组：

| 维度 | 旧 EAV（每字段一行） | JSONB 扩展组（每组一行） |
|---|---|---|
| 行数 | = 字段数（100 字段 → 100 行） | = 组数，即 ext 文件数（100 字段拆 5 文件 → 5 行） |
| 查询 | N 个相关子查询 | N 个 LEFT JOIN + JSON 提取 |
| multi-field struct | 展开成多行，不原子 | 同组 JSON 内多 key，一个文档原子写入 |
| 写入原子性 | N 行各自独立，部分失败留残 | 一个 JSONB 文档，写即全成或全不成 |
| 字段级审计 | ✓ 每行有 created_at | ✗ 只有组级 created_at |
| 范围查询 / 类型索引 | ✓ typed 列可原生索引 | △ 需表达式索引 |
| DB 类型约束 | ✓ 列有精度/长度约束 | △ JSON 弱类型 |

**核心权衡**：扩展组用"字段级审计 + 原生索引 + 类型约束"换取"行数骤减 + 写入原子性 + 查询简化"。对 ERP 典型行为（整体写入、全量读取、偶尔过滤、多字段业务概念需原子更新），扩展组更合适。

注意行数收益取决于**你如何划分文件**——组是文件级的，把字段塞进 1 个文件就是 1 行，拆成 100 个文件就退化成和 EAV 一样的行数。分组是作者的设计决策，应按"一起读写的业务概念"来划分（如 profile 组、finance 组）。

## 为什么独立文件

自定义字段是**部署/配置期**产物（不同租户、不同项目不同），生命周期与
entity/table（开发期）不同。混在一起，diff 会被频繁的部署配置搅乱。
单独的 `.ext.yaml` 文件（与 entity 文件平级放在模块目录下）便于工具扫描与
租户级差异管理。`.ext.yaml` 这个扩展名让加载器一眼识别"这是扩展字段文件"，
与 entity/table/type 等 kind 完全对称。

## 多 owner 叠加（核心特性）

extension_fields 是 loom owner 维度的关键应用场景。多个 owner 可以给同一个
entity 写 extension_fields，加载器**收集所有**并叠加。最终该 entity 的扩展字段
= 各 owner 声明的字段的并集。

```yaml
# ext:acme-corp 给 platform 的 User entity 挂扩展字段
# ext/acme-corp/base/core/user_fields.ext.yaml
entity: entity:base.core.User
group: finance
fields:
  - name: tax_id
    type: { ref: string, args: { max_length: 20 } }

# tenant:acme 给同一个 entity 挂另一组扩展字段
# tenants/acme/base/core/user_fields.ext.yaml
entity: entity:base.core.User
group: profile
fields:
  - name: nickname
    type: { ref: string, args: { max_length: 50 } }
```

叠加结果：User 的扩展字段 = `{ tax_id, nickname }`。两个字段属于不同组
（finance / profile），所以 ext 表里是两行；都进同一张 view。

### 同名字段冲突 = 硬错误

如果两个 owner 都声明了同名字段（如都写 `tax_id`），加载器**报错**，
不覆盖、不合并、不按优先级取舍：

```
ext:acme-corp 的 user_fields: [tax_id]
tenant:acme 的 user_fields:    [tax_id]
→ ❌ 报错：duplicate extension field "tax_id" on entity entity:base.core.User
```

简单、无歧义、无 merge 算法。

### 为什么 extension_fields 不进 nodes map

根本原因是**职责不同**，不是技术限制。

nodes map 存的是"系统里定义了哪些节点"——type/table/entity 是节点定义，每个有
唯一 identity，可以被 `$ref` 引用。这是 nodes map 的语义。

extension_fields 不是节点定义。它是"给某个 entity 附加什么字段"——它的归属维度
是**指向哪个 entity**（`entity: entity:base.core.User`），不是"自己是谁"。没有任何
地方用 `$ref` 引用一个 extension_fields 文件。把它塞进 nodes map 语义上就不对。

按这个职责划分，ext 字段自然按**目标 entity** 组织，而不是按文件自身 identity。
所以 link 阶段把所有 ext 文件收集到 `IR.extensionFields` registry，按 entity identity
分桶。entity 的扩展字段是**按 group 组织的**——每个 group 对应一个 ext 文件，一个
owner 可以给同一个 entity 定义多个 group，不同 owner 的 group 混在同一 entity 下：

```
entity:base.core.User 的扩展字段（按 group 组织）：

  group: profile                      ← platform 的 user_profile.ext.yaml
    nickname, bio
  group: profile                      ← tenant:acme 的 user_fields.ext.yaml
    customer_no
  group: finance                      ← platform 的 user_finance.ext.yaml
    credit_limit
```

投影时，每个 group 在 ext 表里对应一行（`group_name` + `values` JSONB），在 view
里是一个 LEFT JOIN（见下面"view 中的展开"）。同名 group 共享同一个 JOIN——上面
platform 和 tenant:acme 的两个 `profile` 文件，字段都从同一个 `p` JOIN 提取
（`p.values->>'nickname'`、`p.values->>'customer_no'`）。

唯一性约束也从"文件 identity 唯一"变成"同 entity 内字段名唯一"（同名字段才报错，
见上面"同名字段冲突"）。

> **一个技术细节**：因为 ext 不需要被引用，它的 identity（从文件 stem 推导）其实
> 不太重要。多个 owner 用相同文件名（都叫 `user_fields.ext.yaml`）会推导出相同
> identity。discovery 阶段对此做了豁免——ext 的 identity 重复不报错，而其他 kind
> 会。这是"ext 不进 nodes map"这个设计决定的自然后果，而非原因。

详见 [11 加载管线](./11-pipeline.md)。

## view 中的展开

模板里声明的每个字段都会在 view 里展开成虚拟列——通过 LEFT JOIN ext 表 +
JSON 提取。每个组生成一个 JOIN（按 `group_name` 过滤）：

```sql
CREATE VIEW users AS
SELECT
  u.id, u.email, ...,
  p.values->>'nickname' AS nickname,
  p.values->>'bio' AS bio,
  f.values->>'tax_id' AS tax_id,
  f.values->>'credit_limit_amount' AS credit_limit_amount,
  f.values->>'credit_limit_currency_code' AS credit_limit_currency_code
FROM base_core.users_base u
LEFT JOIN users_ext p ON p.base_id = u.id AND p.group_name = 'profile'
LEFT JOIN users_ext f ON f.base_id = u.id AND p.group_name = 'finance';
```

多字段 type（form: struct，如 Money）展开成多个 JSON key
（`credit_limit_amount`、`credit_limit_currency_code`），都落在同一组的 JSON 文档里。
多 owner 叠加的字段都会在同一张 view 里展开——platform 的 `nickname` 和
tenant:acme 的 `customer_no` 若属同一组则共享一个 JOIN，不同组则各自 JOIN。

方言差异：
- **pg**：`p.values->>'nickname'`
- **mysql**：`` p.values->>'$.nickname' ``
- **sqlite**：`json_extract(p.values, '$.nickname')`

## 谁能写 extension_fields

| owner | 能写 extension_fields? | 路径 |
|---|---|---|
| **platform** | ✓ | `platform/<sys>/<mod>/<name>_*.ext.yaml` |
| **ext** | ✓ | `ext/<provider>/<sys>/<mod>/<name>_*.ext.yaml` |
| **tenant** | ✓（这是 tenant 唯一能写的 kind） | `tenants/<id>/<sys>/<mod>/<name>_*.ext.yaml` |

三种 owner 用**完全相同**的 `.ext.yaml` 机制，区别只在 owner 前缀。加载器收集所有
owner 的 `.ext.yaml`、按 entity 聚合（详见上面"多 owner 叠加"）。

详见 [01 目录与身份](./01-layout-and-identity.md) §owner 维度。
