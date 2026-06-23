# loom-schema/v2 规范

> loom 是面向 ERP 的前向设计 Schema DSL：用 YAML 描述设计模型，确定性投影为
> 多方言 SQL DDL（PostgreSQL / MySQL / SQLite）。
>
> 核心理念：**先建模，再投影**。设计层关注语义，投影层关注物理实现。

## 1. 文件格式

每个文件顶格一行 `version: loom-schema/v2`，之后是该 kind 的内容。文件正文**不写**
`kind:`——kind 由文件扩展名决定。

## 2. kind 与扩展名

| 扩展名 | kind | 说明 |
|---|---|---|
| `.type.yaml` | `type` | 类型定义（scalar / struct / enum 三态） |
| `.table.yaml` | `table` | 表定义（物理结构 + 扩展策略） |
| `.entity.yaml` | `entity` | 实体（业务身份层） |
| `.ext.yaml` | `extension_fields` | 扩展字段（按组打包，多 owner 叠加） |

共 4 种 kind。扩展名是 kind 的唯一来源。

## 3. 目录布局与 owner

文件扁平地放在 `<system>/<module>/` 下（无 kind 子目录），顶层用 owner 前缀区分归属：

```
platform/<sys>/<mod>/        ← platform（权威定义，全部 kind）
ext/<provider>/<sys>/<mod>/  ← ext（第三方扩展包）
tenants/<id>/<sys>/<mod>/    ← tenant（仅 .ext.yaml）
```

- **identity** = `kind:sys.mod.Name`，从路径推导。对 type/table/entity，文件声明的
  `name:` 覆盖路径推导（如 scalar 用小写名 `bigint` 而非 `Bigint`）。
- **owner** 从路径顶层前缀推断，**不编码进 identity**。三种 owner：
  `platform` / `ext:<provider>` / `tenant:<id>`。

## 4. type（统一类型定义）

所有类型用同一个 kind `type`，通过 `form` 字段区分三种形态：

| form | 用途 | 命名 | 引用方式 |
|---|---|---|---|
| `scalar` | 系统标量（基底词汇） | 小写 `bigint` / `decimal` / `string` | 短名 |
| `struct` | 复合类型（newtype / 多字段） | PascalCase `Email` / `Money` | 短名或全限定名 |
| `enum` | 枚举（sum type） | PascalCase `Status` | 短名或全限定名 |

```yaml
# decimal.type.yaml
version: loom-schema/v2
name: decimal
form: scalar
properties:
  - { name: precision, type: integer, required: true }
  - { name: scale, type: integer, required: true }

# money.type.yaml
version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type: { ref: decimal, args: { precision: 18, scale: 4 } }
    required: true
  - name: currency_code
    type: { ref: string, args: { max_length: 3 } }
    required: true

# status.type.yaml
version: loom-schema/v2
name: Status
form: enum
variants:
  - { value: active, display_name: Active }
  - { value: inactive }
```

`form` ↔ 专属字段互斥（`properties` 仅 scalar，`fields` 仅 struct，`variants` 仅 enum）。
命名大小写编译期强制：scalar 小写，struct/enum PascalCase。

### 内置标量（18 种，对齐 CDS）

| scalar | CDS | properties | pg | mysql | sqlite |
|---|---|---|---|---|---|
| `uuid` | UUID | — | UUID | CHAR(36) | TEXT |
| `boolean` | Boolean | — | BOOLEAN | BOOLEAN | INTEGER |
| `uint8` | UInt8 | — | SMALLINT | TINYINT | INTEGER |
| `int16` | Int16 | — | SMALLINT | SMALLINT | INTEGER |
| `integer` | Integer | — | INTEGER | INT | INTEGER |
| `bigint` | Int64 | — | BIGINT | BIGINT | INTEGER |
| `decimal` | Decimal | precision, scale | NUMERIC(p,s) | DECIMAL(p,s) | NUMERIC |
| `double` | Double | — | DOUBLE PRECISION | DOUBLE | REAL |
| `string` | String | max_length, pattern | VARCHAR(n) | VARCHAR(n) | TEXT |
| `largestring` | LargeString | — | TEXT | LONGTEXT | TEXT |
| `date` | Date | — | DATE | DATE | TEXT |
| `time` | Time | — | TIME | TIME(6) | TEXT |
| `datetime` | DateTime | — | TIMESTAMPTZ | DATETIME(6) | TEXT |
| `timestamp` | Timestamp | — | TIMESTAMPTZ | TIMESTAMP(6) | TEXT |
| `binary` | Binary | max_length | BYTEA | VARBINARY(n) | BLOB |
| `largebinary` | LargeBinary | — | BYTEA | LONGBLOB | BLOB |
| `vector` | Vector | length | JSONB | JSON | TEXT |
| `map` | Map | — | JSONB | JSON | TEXT |

字段 `type:` 支持简写（裸字符串）和详写（对象 `{ ref, args, meta }`）：

```yaml
- name: email
  type: { ref: string, args: { max_length: 254 } }
```

所有标量参数（`max_length`、`precision`、`scale`）收拢在 `args`，不写在 field 顶层。

### using 导入

`using:` 声明短名解析的命名空间。每个文件**隐含** `base.core.*`（默认导入）。
scalar/struct/enum 走**同一条**短名解析路径，scalar 无特权。

```yaml
using:
  - shop.core.*       # 通配导入
  - base.core.Email   # 精确导入
```

短名解析规则：遍历 using 列表，收集所有命中的 fqn。唯一 → 解析；多个 → 报
`ambiguous`；无 → 报 `unknown type`。全限定名（三段，如 `base.core.Money`）不走
using，直接查节点表。

## 5. table

table 承载物理结构 + 扩展策略：

```yaml
version: loom-schema/v2
name: Products
table:
  name: products_base
  extension:
    strategy: sidecar_eav       # none | json_column | sidecar_eav
    ext_table: products_ext     # 可选，默认 <table>_ext
using:
  - shop.core.*
fields:
  - { name: id, type: bigint, required: true }
  - name: audit
    type: shop.core.Audit
    column: ''                  # flatten（struct 字段插入，无前缀）
  - name: base_price
    type: shop.core.Money       # 多字段 → base_price_amount + base_price_currency_code
primary_key: [id]
indexes:
  - { name: idx_name, fields: [name], unique: true }
foreign_keys:
  - name: fk_orders_user
    fields: [user_id]
    ref_table: users_base
    ref_fields: [id]
    on_delete: cascade
```

### column 字段

| column 值 | 语义 |
|---|---|
| 省略 | 默认 = name（列名或前缀） |
| `''` | flatten（目标字段直接插入，无前缀） |
| `'foo'` | 覆盖物理列名/前缀 |

### 扩展策略

| strategy | 物理布局 |
|---|---|
| `none` | 单表 |
| `json_column` | 单表 + JSONB 列 |
| `sidecar_eav` | base 表 + ext 表（JSONB 扩展组） + view |

### physical_schema

投影期派生：`<system>_<module>`（如 `shop.core` → `shop_core`）。CLI
`--physical-schema <mod>=<name>` 可覆盖。

## 6. entity

entity 在 table 之上加业务身份：

```yaml
version: loom-schema/v2
name: Product
primary_table: table:shop.core.Products   # 身份引用（带 kind 前缀）
business_keys: [name]
audit: true
view: products                             # 可选：逻辑视图名
```

- entity **不重复 fields**——fields 由 table 负责
- view 是 entity 的逻辑视图（base + ext 联合），在 entity 上声明
- v2 投影时 entity 不直接投影，只通过 primary_table

## 7. extension_fields（JSONB 扩展组）

扩展字段按 **group** 打包进 ext 表的 JSONB 列。group 由 `.ext.yaml` 的 `group:`
字段声明（省略时默认 = 文件 stem）。

```yaml
# product_inventory.ext.yaml
version: loom-schema/v2
entity: entity:shop.core.Product
group: inventory
using:
  - shop.core.*
fields:
  - { name: sku, type: { ref: string, args: { max_length: 64 } } }
  - { name: stock_qty, type: bigint }
```

### 物理结构（sidecar_eav）

ext 表行维度 `(base_id, scope, group_name)`：

- **group**（编译期）：字段打包维度。一个 `.ext.yaml` = 一个 group。
- **scope**（运行时）：数据归属维度。每个 owner 有自己的 scope hash 值
  （由应用计算写入），loom 编译期不关心具体值。

```sql
CREATE TABLE products_ext (
  base_id BIGINT NOT NULL,
  scope BIGINT NOT NULL,
  group_name VARCHAR(50) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### view（LEFT JOIN + JSON 提取）

view 不按 scope 过滤——可见性是查询阶段的事。每个 group 一个 LEFT JOIN：

```sql
CREATE VIEW products AS
SELECT u.id, u.name, ...,
  i.values->>'sku' AS sku,
  p.values->>'discount_rate' AS discount_rate
FROM products_base u
LEFT JOIN products_ext i ON i.base_id = u.id AND i.group_name = 'inventory'
LEFT JOIN products_ext p ON p.base_id = u.id AND p.group_name = 'pricing';
```

### 多 owner 叠加

extension_fields 是 owner 维度的关键场景。多个 owner 给同一个 entity 写
`.ext.yaml`，加载器收集所有并叠加。extension_fields **不进 nodes map**——它是
"给 entity 附加字段的配置"，不是节点定义。按 entity identity 分桶存入
`IR.extensionFields`，每个 entry 携带 `group` 和 `owner`。

同名字段冲突 = 硬错误（不覆盖、不合并、不按优先级取舍）。

### 方言差异

| | pg | mysql | sqlite |
|---|---|---|---|
| values 类型 | JSONB | JSON | TEXT |
| JSON 提取 | `->>'key'` | `` ->>'$.key' `` | `json_extract(, '$.key')` |
| 时间 | TIMESTAMPTZ | DATETIME(6) | TEXT |
| enum | CREATE TYPE | ENUM(...) | TEXT + CHECK |

## 8. 引用语法

两个名字空间，不可混用：

| 类型 | 形态 | 用于 | 目标 |
|---|---|---|---|
| 类型引用 | `sys.mod.Name`（无 kind 前缀） | field `type:` | type 节点 |
| 身份引用 | `kind:sys.mod.Name`（带 kind 前缀） | `primary_table:`、`entity:` 等 | 任意节点 |

## 9. 加载管线

确定性 4 阶段，**永不抛异常**——所有错误进入 diagnostics。

| Pass | 阶段 | 职责 |
|---|---|---|
| 0 | Discovery | 扫描目录，按路径推导 identity + owner。ext 豁免 identity 唯一性 |
| 1 | Parse | YAML → typed struct。ext 文件分流到独立列表 |
| 2 | Link | 解析类型引用（短名→fqn），聚合 ext 到 IR.extensionFields，盖 owner 戳 |
| 3 | Validate | 语义校验（required props、primary_key required、ext 目标存在） |

Pass 2 即使有 parse 错误也会运行（暴露尽可能多的诊断）。

## 10. CLI

```sh
loom version                                 # 版本信息
loom check <path>                            # 加载 + 校验
loom fields <path> <entity>                  # 检视 entity 的字段（base + ext groups）
loom project sql --dialect <d> [--out <f>]   # 投影为 SQL DDL（pg | mysql | sqlite）
             [--physical-schema <mod>=<name>]...
```

退出码：0 成功，1 加载/校验失败，2 投影失败，64 用法错误。

## 11. 编程式调用

```typescript
import { load, projectSqlFromIr } from '@loom/core';

const { ir, diagnostics } = await load({ fs, basePath: '/path/to/schema' });
if (diagnostics.hasErrors) { /* ... */ }
const sql = projectSqlFromIr(ir, 'pg');   // 'pg' | 'mysql' | 'sqlite'
```

core 包环境无关——文件系统通过 `FileSystem` 接口注入（支持 Node / 浏览器 / Deno）。

## 12. 错误类别

| category | 触发场景 |
|---|---|
| `parse` | YAML 语法错、字段类型错 |
| `version` | version 字段不匹配 |
| `identity` | identity 重复（ext 豁免） |
| `dangling_ref` | `$ref` 目标不存在 |
| `kind_mismatch` | 目标 kind 与上下文不符 |
| `schema` | 类型解析失败、属性不匹配、ext 同名字段冲突 |
| `semantic` | primary_key 非 required、ext 目标不存在或非 sidecar_eav |

## 13. 已知局限

- 诊断无行号（硬编码 `1:1`，YAML 位置追踪未实现）
- FK 渲染原始（`entity:` refs 不解析为 `primary_table`）
- using 形态 C（重命名）未实现（冲突时用全限定名绕开）
- enum 仅简单形态（值列表；Rust 风格关联数据是未来方向）
- `fmt` / `lift` / `project atlas-yaml` 未实现
