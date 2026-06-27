# 05 · 性能策略

用户明确：**查询执行性能 + kql 内部性能都要，优先查询执行性能**。本文档汇总所有性能决策，分两层组织。

---

## 1. 查询执行性能（优先级 P0）

生成的 SQL 跑得快是首要目标。所有 emit 决策服从这一点。

### 1.1 谓词下推到 JOIN ON（最大收益）

**问题**：sidecar JOIN 是性能大头。LEFT JOIN 后过滤 vs JOIN 前过滤，行数差 N 倍。

**决策**：把 WHERE 中引用 sidecar 列的等值/IN/范围/前缀 LIKE 谓词，提前到 JOIN ON 子句。

**收益**：
- ext 表先按谓词过滤（可走 JSONB GIN 索引），再 JOIN
- DB 优化器选择 NestedLoop + IndexScan 而非 HashJoin 全表
- 实测预期：sidecar 查询从 O(base 行数) 降到 O(匹配行数)

详见 [03-join-injection-and-emit.md](03-join-injection-and-emit.md) §3。

**示例收益对比**：

```sql
-- 不下推 (差): JOIN 全量 base × ext_A
SELECT ... FROM base u LEFT JOIN ext se0 ON ... AND se0.source='A'
WHERE (se0.values->>'sku') = 'X' LIMIT 10
-- 行数扫描 = base 全表 (假设 1M 行)

-- 下推 (好): ext 先过滤
SELECT ... FROM base u LEFT JOIN ext se0
  ON ... AND se0.source='A' AND (se0.values->>'sku') = 'X' LIMIT 10
-- 行数扫描 = 匹配 sku 的 ext 行 (假设 100 行)
-- 收益: 10000x
```

### 1.2 JSONB GIN 友好表达式（pg 专有）

**问题**：JSONB 提取有两种形态，索引支持不同。

**决策**：pg 用 `(values->>'key')::type`，不用 `values @> '{"key":"val"}'`。

**理由**：
- `->>` 返回 text，配合表达式索引或 GIN jsonb_path_ops 都能命中
- `@>` 在默认 GIN 下可用，但 jsonb_path_ops（更小更快）不支持
- 等值/IN 谓词下推后，`(values->>'sku') = 'X'` 走表达式索引或 GIN

**配套索引建议**（loom 投影时生成 DDL，kql 不负责）：
```sql
-- 默认 GIN (支持 @>, ?, ?|)
CREATE INDEX idx_ext_values ON products_ext USING GIN (values);

-- 或表达式索引 (支持 ->>, 更小更快, 针对热点 key)
CREATE INDEX idx_ext_sku ON products_ext ((values->>'sku'));
```

loom 的 sidecar 表 DDL 应在投影时附上推荐索引，DBA 决定建哪些。

### 1.3 JOIN 复用（slot 去重）

**问题**：同 sourceHash 的多列若各自 JOIN，重复扫描 ext 表。

**决策**：slot 唯一键 = `(ExtTable, SourceHash, Kind)`，同 slot 共享一个 JOIN。

**收益**：
- 查询 `project sku, stock_qty`（同 group 同 hash）→ 1 个 JOIN 而非 2 个
- DB 一次扫描 ext 表，多列提取

详见 [03-join-injection-and-emit.md](03-join-injection-and-emit.md) §2.2。

### 1.4 JOIN 顺序字典序（prepared statement 复用）

**问题**：JOIN 顺序变化导致 SQL 文本变化，DB prepared plan cache 失效。

**决策**：slot 排序 = `(Kind, ExtTable, SourceHash)` 字典序，确定性。

**收益**：
- 同一组 ext 字段引用，无论 KQL 里书写顺序，生成相同 SQL 文本
- DB plan cache 命中率高
- 失去 cost-based join order 优化机会，但**正确性优先 + cache 命中收益更大**

**future**：cost-based join order 可在 kql optimizer 层做（基于 stats catalog 的 row_count），生成 hint（pg_hint_plan）。本期不做。

### 1.5 LIMIT 提前下推

KQL `take N` → SQL `LIMIT N`。binder/optimizer 已处理（kql 现状）。

ext 场景额外优化：LIMIT 在 JOIN 后应用，但若谓词已下推到 JOIN ON，DB 优化器会选 StopAfter（pg）或早停（sqlite），不必物化全量 JOIN 结果。**无需 kql 特殊处理**。

### 1.6 复合 PK 的 JOIN ON

**问题**：复合 PK 的 sidecar 表，JOIN ON 需多个 AND。

**决策**：按 `BaseJoinCols[i] = ExtJoinCols[i]` 生成完整 AND 链。

**理由**：缺失任一 JOIN 条件 → 笛卡尔积放大。正确性要求。

### 1.7 GROUP BY 用表达式

**问题**：聚合 group by sidecar 列时，pg 允许别名，sqlite 行为不一致。

**决策**：统一用表达式 `GROUP BY (se0.values->>'sku')::text`，不用别名。

**代价**：SQL 稍冗长，但跨方言一致 + 避免歧义。

---

## 2. kql 内部性能（优先级 P1）

catalog 加载、bind、emit 自身的延迟。次要但需保证不退化。

### 2.1 catalog LRU 缓存

**决策**：全局 LRU，key = `(文件路径, sourceHash, owners 哈希)`。

```
LoadLoomSchema(path, ctx):
  hash := readFileHeader(path).sourceHash   // 仅读头部
  key  := {path, hash, hashOwners(ctx.Owners)}
  if cached := cache.Get(key); cached != nil:
      return cached                          // < 1µs
  // 反序列化 + ForContext
  result := parse(path).ForContext(ctx)
  cache.Put(key, result)
  return result
```

**收益**：重复查询（同 tenant 同 catalog）零解析开销。

**容量**：默认 64 个 catalog（覆盖 64 个 tenant context），LRU 淘汰。

### 2.2 catalog 解析优化

- 用 `encoding/json` 的 `Decoder` 流式解析，避免一次性 `Unmarshal` 大对象
- 字符串 intern：entity 名、scalar 名、owner 名重复率高，intern 后比较 O(1)
- 列预分配：`make([]ColBinding, 0, baseCount+extCount)` 避免扩容

### 2.3 ColBinding.Origin 零分配

**决策**：`Origin` 用具体类型（`PhysicalColumn`/`SidecarJSONKey`）而非接口，避免逃逸到堆。

**权衡**：失去扩展性（未来加新策略需改 switch），换零分配。

**修正**：用接口但保证实现类型可被 escape analysis 识别为栈分配。Go 编译器对小接口+具体类型组合通常能栈分配。需 benchmark 验证。

### 2.4 JoinPlan 缓存

**问题**：同一 pipeline shape 重复计算 JoinPlan。

**决策**：JoinPlan 按 `(pipeline 结构哈希, catalog sourceHash)` 缓存。

**收益**：相同查询模板（不同参数）复用 JoinPlan，只重新生成占位符值。

**风险**：pipeline 结构哈希计算本身有成本，需 benchmark 验证收益 > 哈希成本。短期可不做。

### 2.5 binder 不感知 Origin

**决策**：binder 现有逻辑完全不改，`Origin` 是 emit 阶段才读的死字段。

**收益**：bind 性能与现状持平，不退化。

### 2.6 emit 单趟扫描

JoinPlan 的 PASS 1（扫描列引用）与 emit 的列取值生成合并为单趟，避免两次 walk pipeline。

**实现**：先 PASS 1 收集 slots，PASS 2 分配 alias，PASS 3 下推谓词，**然后** emit 时直接用 aliasOf 生成列表达式——emit 不再 walk，而是基于已收集的 ColBinding 顺序输出。

---

## 3. 性能预算（目标）

| 场景 | 目标 | 测量方法 |
|---|---|---|
| catalog 加载（冷启动, 1MB JSON） | < 50ms | benchmark |
| catalog 缓存命中 | < 1µs | benchmark |
| bind（含 Origin, 不退化） | 与现状持平 ±5% | binder_test benchmark |
| JoinPlan 计算（10 ext 列引用） | < 100µs | benchmark |
| emit（pg, 含 2 JOIN） | < 200µs | benchmark |
| **端到端查询执行（pg, sidecar, 命中 GIN）** | **< 10ms** | pg e2e test |

端到端执行性能是用户最关心的，目标 < 10ms（含网络往返，本地 pg）。

## 4. 性能回归保护

新增 benchmark 套件：

```
internal/loomcatalog/benchmark_test.go
  BenchmarkLoadLoomSchema/cold
  BenchmarkLoadLoomSchema/cached
  BenchmarkSchema

internal/loomcatalog/joinplan_benchmark_test.go
  BenchmarkJoinPlan/10_ext_cols
  BenchmarkJoinPlan/100_ext_cols

internal/backend/pg/benchmark_test.go (扩展现有)
  BenchmarkEmit/sidecar_join
  BenchmarkEmit/new_table_join
```

CI 跑 benchmark + 与基线对比，退化 > 10% 时报警。

## 5. 性能决策汇总表

| # | 决策 | 层 | 收益 | 代价 |
|---|---|---|---|---|
| P1.1 | 谓词下推 JOIN ON | 执行 | 10-10000x | emit +30% 复杂度 |
| P1.2 | `(values->>'k')::t` | 执行 | GIN 命中 | - |
| P1.3 | slot 去重复用 JOIN | 执行 | N 列 → 1 JOIN | - |
| P1.4 | JOIN 字典序 | 执行 | plan cache 命中 | 失去 cost-based 顺序 |
| P1.5 | LIMIT 早停（DB 自动） | 执行 | 自动 | - |
| P1.6 | 复合 PK 完整 AND | 执行 | 正确性 | - |
| P1.7 | GROUP BY 表达式 | 执行 | 跨方言一致 | SQL 冗长 |
| P2.1 | catalog LRU | 内部 | < 1µs 命中 | 内存占用 |
| P2.2 | 流式解析 + intern | 内部 | 大 catalog 快 | 实现复杂 |
| P2.3 | Origin 栈分配 | 内部 | 零 GC | benchmark 验证 |
| P2.4 | JoinPlan 缓存（future） | 内部 | 模板复用 | 哈希成本 |
| P2.5 | binder 不改 | 内部 | 不退化 | - |
| P2.6 | emit 单趟 | 内部 | 少一次 walk | - |

## 6. 未覆盖的性能议题（显式不做）

- **跨进程 catalog 共享**：多 kql 进程共享 catalog 内存（mmap/sharedmem）。单进程够用，不做
- **JSONB 列式压缩**：DB 端 TOAST 配置，属 DBA 职责
- **查询结果缓存**：kql 不缓存查询结果（语义复杂，TTL 难定），由应用层做
- **物化视图**：loom pivot view 的物化（MATERIALIZED VIEW）是 future 议题，与 ext 灵活装配冲突，本期不做
