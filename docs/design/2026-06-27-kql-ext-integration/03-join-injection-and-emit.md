# 03 · JOIN 注入与三方言 emit

本设计的性能核心。给定 IR Pipeline（含带 `Origin` 的 ColBinding），决定需要哪些 JOIN，并在 emit 阶段按方言生成最优 SQL。

**性能优先原则**（用户明确）：宁可 emit 逻辑复杂，也要让生成的 SQL 跑得快。

---

## 1. 问题定义

一条 KQL 查询引用若干列。每列归属三类之一：

| 类别 | Origin 类型 | 物理位置 | 需要 JOIN？ |
|---|---|---|---|
| base 列 | `PhysicalColumn{base}` | base 表真实列 | 否 |
| new_table ext 列 | `PhysicalColumn{ext_table}` | ext 表真实列 | 是（一次/ext 表） |
| sidecar ext 列 | `SidecarJSONKey` | sidecar 表的 JSONB `values` 文档 | 是（一次/slot） |

**关键观察**：
- 同 sidecar 表 + 同 sourceHash 的多列 → **共享一个 JOIN**（同一 JSONB 行）
- 同 sidecar 表 + 不同 sourceHash → **强制分离 JOIN**（不同行，需各自 source 过滤）
- new_table ext 表 → 按 ext 表名去重 JOIN

## 2. JoinPlan 算法

### 2.1 数据结构

```go
// internal/loomcatalog/joinplan.go

// JoinSlot 唯一标识一个需要 JOIN 的物理来源
// 去重键: (SidecarTable, SourceHash, Kind)
type JoinSlot struct {
    Kind         string  // "sidecar" | "new_table"
    ExtTable     string  // 物理表名
    SourceHash   string  // sidecar: 非空; new_table: ""
}

type JoinSpec struct {
    Slot         JoinSlot
    Alias        string  // se0, se1, ... (sidecar); et0, et1, ... (new_table)
    BaseJoinCols []string
    ExtJoinCols  []string
    OnSource     bool    // sidecar=true: AND source = '<hash>'
}

type JoinPlan struct {
    BaseTable string       // 含 schema 前缀
    BaseAlias string       // 通常 "u"
    Joins     []JoinSpec
    // 谓词下推用: WHERE/JOIN ON 中引用 sidecar 列的谓词, 提前到 JOIN ON 子句
    PushedPreds []PushedPred
}

type PushedPred struct {
    Slot     JoinSlot
    Expr     string  // 方言相关, 如 "(se0.values->>'sku') = ?1"
}
```

### 2.2 三趟扫描

```
输入: IR Pipeline + 已过滤的 LoomCatalog
输出: JoinPlan + 每个 ColBinding 的物理取值表达式 (emit 时用)

PASS 1 — 扫描所有列引用, 收集 JoinSlot
  neededSlots := map[JoinSlot]bool{}

  for each Col c in walkPipeline(pipeline):
      // walkPipeline 遍历 source + 所有 stage 的 expr
      //   source: 表名 (已知)
      //   stage.expr: where/filter/project/extend/sort/aggregate 的所有子表达式
      if c.Origin == nil:
          continue  // base 列, 不需要 JOIN

      switch origin := c.Origin.(type) {
      case PhysicalColumn:
          if origin.Table == baseTable:
              continue  // base 列
          // new_table ext 列
          neededSlots[JoinSlot{Kind:"new_table", ExtTable: origin.Table}] = true

      case SidecarJSONKey:
          neededSlots[JoinSlot{
              Kind:       "sidecar",
              ExtTable:   origin.SidecarTable,
              SourceHash: origin.SourceHash,
          }] = true
      }

PASS 2 — 分配别名 + 排序 (保证 SQL 稳定, 利于 prepared statement 复用)
  slots := sortedKeys(neededSlots)
  // 排序键: (Kind, ExtTable, SourceHash) 字典序
  // 同一物理表的多个 sourceHash 相邻, 利于 DB 优化器合并扫描

  for i, slot := range slots:
      alias := (slot.Kind == "sidecar") ? "se"+i : "et"+i
      joins = append(joins, JoinSpec{
          Slot:         slot,
          Alias:        alias,
          BaseJoinCols: catalog.BaseJoinCols(slot.ExtTable),
          ExtJoinCols:  catalog.ExtJoinCols(slot.ExtTable),
          OnSource:     slot.Kind == "sidecar",
      })
      aliasOf[slot] = alias

PASS 3 — 谓词下推 (性能关键, 见 §3)
  // 扫描 WHERE 子句, 把引用 sidecar 列的等值/IN 谓词提前到 JOIN ON
  pushedPreds := extractSidecarPredicates(whereClause, aliasOf)

输出: JoinPlan{BaseTable, BaseAlias, Joins, PushedPreds}
      + aliasOf (供 emit PASS 4 用)
```

### 2.3 列取值表达式（emit PASS 4）

```
for each Col c in pipeline:
    switch origin := c.Origin.(type) {
    case nil, PhysicalColumn(base):
        emit BaseAlias + "." + c.PhysicalName
        // "u.id", "u.name"

    case PhysicalColumn(new_table):
        slot := JoinSlot{Kind:"new_table", ExtTable: origin.Table}
        emit aliasOf[slot] + "." + origin.Column
        // "et0.sku", "et1.warranty_months"

    case SidecarJSONKey:
        slot := JoinSlot{Kind:"sidecar", ExtTable: origin.SidecarTable, SourceHash: origin.SourceHash}
        emit dialectExtractSidecar(aliasOf[slot], origin, c.Type)
        // pg:     "(se0.values->>'sku')::text"
        // sqlite: "CAST(json_extract(se0.values, '$.sku') AS TEXT)"
        // loom:   "u.sku"   (逻辑形态, 不展开)
    }
```

## 3. 谓词下推（性能关键）

### 3.1 动机

sidecar JOIN 是性能大头。如果 WHERE 引用 sidecar 列：

```sql
-- 差: 先 LEFT JOIN 全量, 再过滤
SELECT ... FROM base u LEFT JOIN ext se0 ON se0.base_id_0=u.id AND se0.source='A'
WHERE (se0.values->>'sku') = 'X'
```

JOIN 后 base 的每行都展开一行 ext（即使 sku 不匹配），再过滤。**行数 = base 行数**。

```sql
-- 好: 谓词提前到 JOIN ON, JOIN 前先过滤 ext
SELECT ... FROM base u LEFT JOIN ext se0
  ON se0.base_id_0=u.id
  AND se0.source='A'
  AND (se0.values->>'sku') = 'X'   -- ★ 提前
```

ext 表先按 sku 过滤（可用 JSONB GIN 索引），再 JOIN。**行数 = 匹配 sku 的 ext 行数**。

### 3.2 可下推谓词判定

不是所有谓词都能下推。规则：

| 谓词形态 | 可下推？ | 理由 |
|---|---|---|
| `sidecar_col = literal` | ✅ | 等值，ext 表可走索引 |
| `sidecar_col IN (literals)` | ✅ | 同上 |
| `sidecar_col IS NULL` | ⚠️ 谨慎 | LEFT JOIN 语义：null 可能是「无 ext 行」也可能是「ext 值为 null」，下推改变语义 |
| `sidecar_col < literal` | ✅ | 范围，可走索引 |
| `sidecar_col LIKE 'prefix%'` | ✅ | 前缀匹配，可走索引 |
| `func(sidecar_col)` | ❌ | 函数包装，索引失效，且语义可能复杂 |
| `sidecar_col AND base_col` | ⚠️ 部分 | 拆分：sidecar_col 部分下推，base_col 留 WHERE |

### 3.3 下推算法

```
extractSidecarPredicates(whereExpr, aliasOf) → []PushedPred:

  walk whereExpr:
    if node is AND:
        recurse(left); recurse(right)
    elif node is BinOp(op, left, right):
        slot := sidecarSlotReferenced(left, right)
        if slot != nil && isPushdownable(op):
            // 重写为 JOIN ON 表达式 (用 aliasOf[slot])
            pushedExpr := rewriteForJoinON(node, aliasOf[slot])
            pushed.append(PushedPred{Slot: slot, Expr: pushedExpr})
            markRemoved(node)  // 从 WHERE 中移除
        # else: 留在 WHERE

  return pushed
```

### 3.4 LEFT JOIN 语义保护

LEFT JOIN 时，base 行即使无匹配 ext 行也会出现在结果里（ext 列为 NULL）。谓词下推到 ON **不改变这个语义**——下推的谓词只是限制「哪些 ext 行参与 JOIN」，不影响 base 行的存在。

**但要小心**：如果原查询语义是「只返回有 ext 行的 base」（即 INNER JOIN 语义），下推等价于把 LEFT 改成 INNER 的效果。这通常正是用户想要的（查 `where sku = 'X'` 隐含「有 sku」），但 kql 应在 explain 输出里标注 `join promoted: LEFT→effective INNER (predicate pushed)`。

## 4. FROM 子句生成

```
FROM <BaseTable> <BaseAlias>
[LEFT JOIN <ExtTable> <Alias>
   ON <Alias>.<ExtJoinCols[0]> = <BaseAlias>.<BaseJoinCols[0]>
   [AND <Alias>.<ExtJoinCols[1]> = <BaseAlias>.<BaseJoinCols[1]>]   // 复合 PK
   [AND <Alias>.source = '<SourceHash>']                            // sidecar only
   [AND <PushedPred.Expr>]                                          // 谓词下推
]*
```

## 5. 方言提取规则

### 5.1 pg（JSONB 友好）

```go
func pgExtractSidecar(alias string, o SidecarJSONKey, t ir.Type) string {
    key := o.JSONKey
    // 用 ->> 取 text, 再 ::cast 到目标类型
    // ★ 用 ->> 而非 ->: ->> 返回 text, 利于 GIN 索引 (jsonb_path_ops)
    sqlType := pgType(t)
    return fmt.Sprintf("(%s.values->>'%s')::%s", alias, key, sqlType)
}
```

**GIN 索引友好性**（性能优先）：
- 表达式 `(values->>'sku')` 配合 `CREATE INDEX ... ON ext USING GIN (values jsonb_path_ops)` 可走索引
- 不要用 `values @> '{"sku":"X"}'` 形式——那是 jsonb_path_ops 不支持的（除非用默认 GIN）
- 等值/IN 谓词下推后，planner 自动选择 GIN 扫描 vs 顺序扫描

### 5.2 sqlite（json_extract）

```go
func sqliteExtractSidecar(alias string, o SidecarJSONKey, t ir.Type) string {
    key := o.JSONKey
    sqlType := sqliteType(t)
    // json_extract 返回已类型推断的值; CAST 强制类型
    return fmt.Sprintf("CAST(json_extract(%s.values, '$.%s') AS %s)", alias, key, sqlType)
}
```

SQLite 的 JSON 索引能力弱（需表达式索引），谓词下推仍有效（减少 JSON 解析次数）。

### 5.3 loom（逻辑形态，不展开）

```go
func loomExtractSidecar(baseAlias string, o SidecarJSONKey, _ ir.Type) string {
    // 逻辑视图: 当作扁平列, 不暴露 JOIN / JSONB / sourceHash
    return fmt.Sprintf("%s.%s", baseAlias, o.JSONKey)
}
```

详见 [04-loom-dialect.md](04-loom-dialect.md)。

## 6. 完整示例

KQL：`Product | where sku == 'X' | project name, stock_qty | take 10`
（sku + stock_qty 同 group 同 sourceHash；warranty_months 不可见或未被引用）

### 6.1 JoinPlan 计算

```
PASS 1:
  where sku == 'X'       → SidecarJSONKey(products_ext, hash=A, jsonKey=sku)     → slot S1
  project stock_qty      → SidecarJSONKey(products_ext, hash=A, jsonKey=stock_qty) → slot S1 (同)
  project name           → base, 跳过

PASS 2:
  slots = [S1]
  joins = [JoinSpec{slot=S1, alias="se0", BaseJoinCols=["id"], ExtJoinCols=["base_id_0"], OnSource=true}]

PASS 3 (谓词下推):
  where sku == 'X' 引用 sidecar 列, 等值谓词, 可下推
  pushedPreds = [PushedPred{slot=S1, expr="(se0.values->>'sku')::text = ?1"}]
  where 子句移除该谓词 → where 变空 → 整个 where 移除
```

### 6.2 pg emit 结果

```sql
SELECT u.name,
       (se0.values->>'stock_qty')::bigint AS stock_qty
FROM shop_core.products_base u
LEFT JOIN products_ext se0
  ON se0.base_id_0 = u.id
  AND se0.source = 'a1b2c3d4e5f67890'
  AND (se0.values->>'sku')::text = $1     -- ★ 谓词下推
LIMIT 10
```

DB 执行计划（理想）：
```
Limit (cost=... rows=10)
  → Nested Loop
      → Bitmap Heap Scan on products_ext se0
          Recheck Cond: ((values->>'sku') = 'X')
          Filter: (source = 'a1b2c3d4e5f67890')
          → Bitmap Index Scan on idx_ext_values_gin   -- ★ GIN 命中
      → Index Scan using products_pkey on products_base u
          Index Cond: (id = se0.base_id_0)
```

**对比不下推**（差）：
```sql
SELECT u.name, (se0.values->>'stock_qty')::bigint AS stock_qty
FROM shop_core.products_base u
LEFT JOIN products_ext se0 ON se0.base_id_0=u.id AND se0.source='A'
WHERE (se0.values->>'sku')::text = $1
LIMIT 10
```
DB 先 JOIN 全量 base × ext（A source），再过滤 sku。**行数 = base 全表**。

### 6.3 sqlite emit 结果

```sql
SELECT u.name,
       CAST(json_extract(se0.values, '$.stock_qty') AS INTEGER) AS stock_qty
FROM products_base u
LEFT JOIN products_ext se0
  ON se0.base_id_0 = u.id
  AND se0.source = 'a1b2c3d4e5f67890'
  AND CAST(json_extract(se0.values, '$.sku') AS TEXT) = ?1
LIMIT 10
```

### 6.4 loom emit 结果（逻辑形态）

```sql
SELECT u.name, u.stock_qty
FROM Product u
WHERE u.sku = ?1
LIMIT 10
```

不展开 JOIN/JSONB/sourceHash。供审计/解释/反向消费。

## 7. 边界情况

### 7.1 同表多 sourceHash → 多 JOIN

KQL: `Product | where sku == 'X' | project warranty_code`
（sku 是 hash=A，warranty_code 是 hash=B，同在 products_ext）

```
slots = [
  S1: sidecar(products_ext, hash=A),  alias=se0
  S2: sidecar(products_ext, hash=B),  alias=se1
]
```

```sql
FROM products_base u
LEFT JOIN products_ext se0 ON se0.base_id_0=u.id AND se0.source='A' AND (se0.values->>'sku')::text = $1
LEFT JOIN products_ext se1 ON se1.base_id_0=u.id AND se1.source='B'
```

**不能合并**——物理上是不同行。slot 唯一键含 sourceHash 保证分离。

### 7.2 复合 PK

base PK = `[tenant_id, id]`：

```sql
LEFT JOIN products_ext se0
  ON se0.base_id_0 = u.tenant_id
  AND se0.base_id_1 = u.id
  AND se0.source = 'A'
```

`BaseJoinCols`/`ExtJoinCols` 数组 zip 生成多个 AND。

### 7.3 new_table ext

KQL: `Product | project warranty_months`

```
slots = [T1: new_table(shop_core_product_warranty)]
joins = [JoinSpec{slot=T1, alias="et0", BaseJoinCols=["id"], ExtJoinCols=["id"], OnSource=false}]
```

```sql
SELECT et0.warranty_months
FROM shop_core.products_base u
LEFT JOIN shop_core_product_warranty et0 ON et0.id = u.id
```

### 7.4 全 ext 查询（不引用 base 列）

KQL: `Product | project sku, stock_qty`（无 base 列）

JoinPlan 仍以 base 为驱动表（FROM base u），因为 ext 表的 base_id 是 FK，base 是「主」。即使不选 base 列，也用 base 做 LEFT JOIN 的左表。这是设计选择——保持 base 始终是查询主体。

**优化（future）**：如果检测到「无 base 列引用 + 无 where base 列」，可改为以 ext 表为驱动（FROM ext ... 反向 JOIN base），减少 base 全表扫描。本期不做。

### 7.5 聚合查询

KQL: `Product | summarize count() by sku`

sku 是 group key（sidecar 列）。聚合的 group by 直接用提取表达式：

```sql
SELECT (se0.values->>'sku')::text AS sku, count(*) AS count_
FROM shop_core.products_base u
LEFT JOIN products_ext se0 ON se0.base_id_0=u.id AND se0.source='A'
GROUP BY (se0.values->>'sku')::text
```

**注意**：GROUP BY 用表达式而非别名，因为某些方言（pg）允许别名，但 sqlite 行为不一致。统一用表达式更安全。

### 7.6 JOIN 顺序

多个 JOIN 的顺序遵循 PASS 2 的排序：`(Kind, ExtTable, SourceHash)` 字典序。这保证：
- 同物理表的 JOIN 相邻（DB 优化器可能合并扫描）
- SQL 文本稳定（利于 prepared statement 复用）

复杂 JOIN 顺序优化（cost-based）是 optimizer 的 future work，本期用确定性顺序。

## 8. 性能决策汇总

| 决策 | 取舍 | 理由 |
|---|---|---|
| 谓词下推到 JOIN ON | emit 逻辑 +30% | 查询执行 -50%~90% |
| `(values->>'key')::type` 而非 `values @>` | 表达式稍长 | GIN jsonb_pathops 兼容 |
| slot 排序字典序 | 失去 cost-based 优化机会 | SQL 稳定 + prepared 复用（先求正确+可缓存） |
| JOIN 别名确定性（se0/et0） | 不可读 | prepared statement plan cache 友好 |
| base 始终驱动 | 部分场景次优 | 简化正确性，future 优化 ext 驱动 |
| GROUP BY 用表达式 | SQL 稍冗长 | 跨方言一致 |

完整性能策略见 [05-performance-strategy.md](05-performance-strategy.md)。
