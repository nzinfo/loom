# 设计记录：JSONB 扩展组取代 EAV

- **日期**：2026-06-22
- **状态**：已实现（schema 层 + 投影层均落地，3 方言 + golden 已更新）
- **动机**：EAV typed columns 在 100+ 扩展字段时行数爆炸（一字段一行）、查询慢（N 个子查询）、multi-field struct 拆行不原子。JSONB 扩展组是综合更优的存储模型。

## 1. 背景：当前 sidecar_eav 的物理模型

```sql
CREATE TABLE users_ext (
  base_id BIGINT NOT NULL,
  tenant_id BIGINT,
  field_name VARCHAR(100) NOT NULL,
  data_type VARCHAR(20) NOT NULL,
  int_value BIGINT,           -- typed value columns
  decimal_value NUMERIC(18,4),
  string_value TEXT,
  datetime_value TIMESTAMPTZ,
  boolean_value BOOLEAN,
  json_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**每字段一行**——100 个扩展字段 = 100 行/实体。view 用 N 个子查询 pivot。

## 2. 新方案：JSONB 扩展组

### 2.1 扩展组概念

引入 **group** ——多个扩展字段属于同一个组，打包成一行 JSONB。组由 `.ext.yaml` 文件的 `group:` 字段声明（可选，默认 = 文件 stem）。

```yaml
# user_profile.ext.yaml
entity: entity:base.core.User
group: profile
fields:
  - { name: nickname, type: string }
  - { name: avatar, type: string }
  - { name: bio, type: text }

# user_finance.ext.yaml
entity: entity:base.core.User
group: finance
fields:
  - { name: credit_limit, type: base.core.Money }
  - { name: score, type: integer }
```

### 2.2 物理结构

```sql
CREATE TABLE users_ext (
  base_id BIGINT NOT NULL,
  tenant_id BIGINT,
  group_name VARCHAR(50) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

数据（每实体 + 每 tenant + 每组一行）：
```
base_id=1, tenant_id=NULL, group_name='profile',
  values='{"nickname":"Alice","avatar":"x.png","bio":"engineer"}'

base_id=1, tenant_id=NULL, group_name='finance',
  values='{"credit_limit_amount":5000,"credit_limit_currency_code":"USD","score":750}'

base_id=1, tenant_id=1, group_name='profile',
  values='{"nickname":"Bob"}'
```

**分组粒度是文件级**——一个 `.ext.yaml` 文件里所有字段共享同一个 group。行数 =
你划分了多少个文件（组）。把 100 个字段拆到 5 个文件 → 每 entity 每 tenant 5 行
（而非 100 行）；塞进 1 个文件 → 1 行。组划分是作者的主动设计决策。

### 2.3 view：LEFT JOIN + JSON 提取

```sql
CREATE VIEW base_core.users AS
SELECT
  u.id, u.email, ...,
  p.values->>'nickname' AS nickname,
  f.values->>'score' AS score,
  (f.values->>'credit_limit_amount')::numeric AS credit_limit_amount
FROM base_core.users_base u
LEFT JOIN base_core.users_ext p ON p.base_id = u.id AND p.group_name = 'profile'
  AND (p.tenant_id IS NULL OR p.tenant_id = current_tenant())
LEFT JOIN base_core.users_ext f ON f.base_id = u.id AND f.group_name = 'finance'
  AND (f.tenant_id IS NULL OR f.tenant_id = current_tenant());
```

**N 个 group → N 个 LEFT JOIN + JSON 提取**（而非 N 个子查询）。

## 3. 与 EAV 的对比

| 维度 | EAV typed | JSONB 扩展组 |
|---|---|---|
| 100 字段行数 | 100 | 5（按组） |
| 查询 | 100 子查询 | 5 JOIN + JSON 提取 |
| multi-field struct | 拆多行 | 同组 JSON 内多 key |
| 字段级审计 | ✓ 每行 created_at | ✗（组级审计） |
| 字段级并发 | ✓ 无冲突 | 组间无冲突，组内有竞争 |
| 范围查询 | ✓ typed 索引 | △ 表达式索引 |
| DB 类型约束 | ✓ | △ JSON 弱类型 |
| 多租户 | ✓ | ✓ |
| 值类型精度 | ✓ DB 原生 | △ JSON 数值（无精度/长度约束） |

**扩展组在行数、查询、multi-field 原子性上优于 EAV；在字段级审计、并发、索引上弱于 EAV。** 对 ERP 典型行为模式（整体写入、全量读取、偶尔过滤），扩展组更合适。

## 4. 已落地（schema 层）

- `ExtensionFieldsSchema`：新增 `group: z.string().optional()` 字段
- `ExtensionFieldEntry`：新增 `group: string` 属性
- `collectExtensionFields`（link.ts）：从 `.ext.yaml` 的 `group:` 或文件 stem 填充 group

## 5. 投影层实现（已完成）

### 5.1 ext 表 DDL（pg/mysql/sqlite）

三种方言的 `extTableBlock` 已重写：
- 删除 `field_name`、`data_type`、6 个 typed value 列
- 新增 `group_name VARCHAR(50) NOT NULL` + `values JSONB NOT NULL`
- 保留 `base_id`、`tenant_id`、`created_at`

方言差异：
- pg：`values JSONB NOT NULL DEFAULT '{}'::jsonb`、`TIMESTAMPTZ`
- mysql：`values JSON NOT NULL DEFAULT (JSON_OBJECT())`、`DATETIME(6)`
- sqlite：`values TEXT NOT NULL DEFAULT '{}'`、`TEXT`（时间）

### 5.2 PivotView 接口重设计（已完成）

```ts
interface GroupJoin {
  readonly group: string;       // group name
  readonly alias: string;       // SQL alias (e.g. 'p', 'f', 'e0')
}
interface PivotColumn {
  readonly fieldName: string;   // JSON key in the group's values
  readonly groupAlias: string;  // which group join's alias
}
interface PivotView {
  readonly viewName: string;
  readonly baseTable: string;
  readonly extTable: string;
  readonly baseColumns: readonly string[];
  readonly columns: readonly PivotColumn[];
  readonly groupJoins: readonly GroupJoin[];
}
```

### 5.3 buildPivotViews 重写（已完成）

- 按 entity 收集所有扩展字段，按 group 分组（保持首次出现顺序）
- 每个 group 生成一个 GroupJoin（alias 用 group 首字母小写；冲突时回退 e0/e1/...；
  'u' 保留给 base table）
- 每个 field 生成一个 PivotColumn（fieldName = field name or `<prefix>_<subfield>`，
  groupAlias = 所在 group 的 alias）；多字段 struct ref 展开成多个 JSON key

### 5.4 方言 view block 重写（已完成）

pg/mysql/sqlite 的 `viewBlock` 改为 LEFT JOIN + JSON 提取：
- pg：`alias.values->>'field' AS field`
- mysql：`` alias.values->>'$.field' AS field ``
- sqlite：`json_extract(alias.values, '$.field') AS field`

JOIN 子句：`LEFT JOIN <ext> <alias> ON <alias>.base_id = u.id AND <alias>.group_name = '<group>'`

### 5.5 golden 更新（已完成）

`base_schema.pg.sql` 已重新生成：ext 表 DDL 用 `group_name + values JSONB`，
view 用两个 LEFT JOIN（profile 组 + finance 组）+ JSON 提取。

## 6. multi-field struct 在 JSONB 里的展开

当前 expand 把 multi-field struct（Money）展开成多个列名（`balance_amount`、`balance_currency_code`）。在 JSONB 方案里，这些仍然是 JSON 的独立 key（`values->>'balance_amount'`）。multi-field struct 的展开逻辑不变——只是存储从"多行 typed columns"变成"一行 JSON 多 key"。

## 7. 后续：三种策略并存

| 策略 | 物理模型 | 状态 |
|---|---|---|
| `sidecar_eav` | 独立 ext 表，每字段一行，typed columns | **将被 sidecar_jsonb 取代** |
| `sidecar_jsonb` | 独立 ext 表，每实体+tenant+组一行，JSONB | **本文档描述的方案** |
| `jsonb` | base 表加 JSONB 列，无 ext 表 | 未来 |

当前 `sidecar_eav` 策略名保留（向下兼容），但投影逻辑改为 JSONB 扩展组。或重命名为 `sidecar_jsonb`（破坏性，无外部用户，可接受）。
