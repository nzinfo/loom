# 06 · 落地计划

实现顺序、文件改动清单、测试策略、风险登记。按依赖排序，每阶段独立可测。

---

## 1. 阶段划分

```
阶段 0 (loom 侧)  ──▶ 阶段 1 (catalog 骨架)  ──▶ 阶段 2 (JOIN+emit)
                                                       │
                                                       ├─▶ 阶段 3 (loom 方言)
                                                       │
                                                       └─▶ 阶段 4 (多租户 + 缓存)
                                                              │
                                                              └─▶ 阶段 5 (性能 + 集成)
```

每阶段交付可独立 review 的小步，不强求一次完成。

## 2. 阶段详述

### 阶段 0：loom 投影出 loom-schema.json

**范围**：loom 侧新增 catalog JSON emitter。

**改动文件**：
```
packages/core/src/projector/
├── catalog.ts              ★ 新增: PhysicalModel → LoomCatalog JSON
└── sql.ts                  扩展: project() 增加 'schema' 输出模式
packages/cli/src/commands/
└── project.ts (或新命令)   扩展: loom project schema --out loom-schema.json
packages/core/tests/
└── catalog.test.ts         ★ 新增: golden 测试
```

**关键决策**：
- 复用现有 `PhysicalModel` + `IR.extensionFields`，不引入新数据
- JSON schema 用 Zod 校验（与 loom 技术栈一致）
- golden 测试：固定一份输入 yaml，断言输出 JSON

**完成标准**：
- `loom project schema` 能从 `examples/product/` 生成 `loom-schema.json`
- golden 测试通过
- JSON 通过 `version: loom-schema/v1` 校验

### 阶段 1：kql LoomCatalog 骨架（不含 emit）

**范围**：kql 侧加载 catalog，实现 SchemaProvider，**先只支持 base 列**（验证 entity 名解析）。

**改动文件**：
```
internal/loomcatalog/                 ★ 新增包
├── catalog.go                        LoomCatalog 结构 + Schema() 实现
├── origin.go                         ColumnOrigin 类型
├── loader.go                         JSON → LoomCatalog
└── catalog_test.go                   加载 + Schema() 单元测试

internal/frontend/binder/
└── binder.go                         ColBinding 加 Origin 字段

internal/backend/sqlite/schema.go     构造 ColBinding 时 Origin=nil (等价旧行为)
internal/backend/pg/backend.go        同上
internal/backend/duckdb/backend.go    同上

pkg/kql/
├── kql.go                            新增 --loom-schema 选项, 接入 CompositeProvider
└── options.go (或新文件)             LoomSchema/Owners 配置
```

**完成标准**：
- `kql --loom-schema ./out/ 'Product | take 1'` 能解析 entity 名 "Product"
- base 列正确绑定（id, name, base_price）
- ext 列暂时也绑定（Origin 已填），但 emit 暂不展开（下阶段做）
- 现有 binder/backend 测试全绿（Origin=nil 等价旧行为）

### 阶段 2：JOIN 注入 + 三方言 emit（核心）

**范围**：sidecar_jsonb + new_table 的 emit 实现，pg/sqlite 方言展开 JOIN。

**改动文件**：
```
internal/loomcatalog/
├── joinplan.go                       ★ 新增: JoinPlan 算法 (PASS 1-3)
└── joinplan_test.go                  ★ 新增

internal/backend/pg/
└── emit.go                           扩展: 处理 ColBinding.Origin + JoinPlan

internal/backend/sqlite/
└── emit.go                           同上

pkg/kql/
└── kql.go                            Emit 流程串入 JoinPlan
```

**子阶段**（建议拆分 review）：
- 2a：JoinPlan 算法（PASS 1-2，不含谓词下推）
- 2b：sidecar emit（pg + sqlite）
- 2c：new_table emit
- 2d：谓词下推（PASS 3）
- 2e：边界（复合 PK、同表多 sourceHash、聚合）

**完成标准**：
- `Product | where sku == 'X' | take 10` 在 pg 上生成正确 SQL 并执行
- golden 测试覆盖各子阶段
- 谓词下推的 SQL 文本与 [03-join-injection-and-emit.md](03-join-injection-and-emit.md) §6.2 一致

### 阶段 3：loom 方言

**范围**：逻辑方言，仅用于 explain。

**改动文件**：
```
internal/backend/loom/                ★ 新增包
├── backend.go                        Backend 接口实现, Dialect()="loom"
├── emit.go                           逻辑形态 emit
└── backend_test.go

cmd/kql/
└── main.go                           explain 子命令支持 --dialect loom
```

**完成标准**：
- `kql explain --dialect loom --loom-schema ./out/ 'KQL...'` 输出逻辑 SQL
- 跨方言等价性测试：loom SQL vs pg SQL 列名/谓词结构对照
- `loom.Exec()` 返回 "non-executable" 错误

### 阶段 4：多租户过滤 + catalog 缓存

**范围**：context 过滤、LRU 缓存、CLI options。

**改动文件**：
```
internal/loomcatalog/
├── context.go                        ★ 新增: Context + ForContext()
├── cache.go                          ★ 新增: LRU
└── context_test.go                   ★ 新增

pkg/kql/
└── kql.go                            --loom-owners 选项

cmd/kql/
└── main.go                           CLI 解析
```

**完成标准**：
- `--loom-owners platform,ext:provider-a` 正确过滤
- tenant:42 查不到 tenant:99 的 ext 列（KQL001）
- catalog 缓存命中 benchmark 达标（< 1µs）

### 阶段 5：性能优化 + 集成测试

**范围**：benchmark 套件、性能调优、e2e 集成测试。

**改动文件**：
```
internal/loomcatalog/
└── benchmark_test.go                 ★ 新增

internal/backend/pg/
└── benchmark_test.go (扩展)          sidecar JOIN emit benchmark

tests/e2e/                            ★ 新增或扩展
└── loom_ext_test.go                  端到端: pg 容器 + loom catalog + 真实查询
```

**完成标准**：
- 全部 benchmark 达 [05-performance-strategy.md](05-performance-strategy.md) §3 目标
- 端到端 pg 查询 < 10ms
- CI 集成 benchmark 回归检测

## 3. 测试策略

### 3.1 单元测试

| 包 | 重点 |
|---|---|
| `loomcatalog` | catalog 加载、Schema()、ForContext()、JoinPlan 各 PASS |
| `binder` | Origin 字段不破坏现有测试（回归） |
| `pg`/`sqlite`/`loom` emit | Origin 各分支、谓词下推、边界 |

### 3.2 Golden 测试

| 项 | 内容 |
|---|---|
| loom catalog JSON | 固定 yaml 输入 → 固定 JSON 输出 |
| kql emit SQL | 固定 KQL + catalog → 固定 pg/sqlite/loom SQL（参考现有 golden 框架，STATUS.md:84） |

### 3.3 e2e 测试

```
tests/e2e/loom_ext_test.go:

  setup:
    - pg 容器 (复用 docker-compose.pg.yml)
    - 建表: products_base + products_ext (含 GIN 索引)
    - 插入测试数据 (含 ext JSONB 行)
    - loom project schema 生成 catalog

  cases:
    - base 列查询
    - sidecar ext 列查询 (单 group)
    - sidecar ext 列查询 (多 sourceHash)
    - new_table ext 列查询
    - 谓词下推验证 (EXPLAIN 检查索引命中)
    - 多租户过滤 (tenant A 看不到 tenant B 列)
    - 聚合查询 (group by ext 列)
    - 复合 PK
```

### 3.4 性能回归

- benchmark 套件纳入 CI
- 与基线对比，退化 > 10% 报警
- 基线版本记录在 `docs/design/2026-06-27-kql-ext-integration/perf-baseline.md`（future）

## 4. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | `ColBinding.Origin` 接口导致堆分配，bind 性能退化 | 中 | 中 | benchmark 验证；必要时改具体类型 |
| R2 | 谓词下推改变 LEFT JOIN 语义 | 中 | 高 | 严格的可下推判定（§3.2）；explain 标注；e2e 测试覆盖 |
| R3 | catalog JSON 格式演进破坏 kql | 低 | 中 | 版本字段 + Zod 校验；破坏性变更 bump v2 |
| R4 | pg 优化器不选 GIN 索引 | 中 | 高 | EXPLAIN 验证；必要时用 pg_hint_plan；文档化推荐索引 |
| R5 | 多 owner 过滤遗漏，泄露 tenant 数据 | 中 | 极高 | 单元测试 + e2e 隔离测试；默认 context 不含 tenant |
| R6 | JoinPlan 算法复杂查询（深嵌套）性能差 | 低 | 中 | benchmark；必要时缓存 |
| R7 | loom catalog 与 DB 实际 schema 漂移 | 中 | 高 | 文档化「catalog 是 source of truth」；future: 启动时抽样校验 |
| R8 | sqlite JSON 性能差（无 GIN） | 高 | 低 | 谓词下推仍有效；sqlite 主要用于测试，生产走 pg |

## 5. 验收标准（整体）

设计完成、可发布时，应满足：

- [ ] loom 能从 examples 生成 loom-schema.json
- [ ] kql 加载 catalog，bind 正确（base + ext 列）
- [ ] pg/sqlite emit 生成含 JOIN 的正确 SQL
- [ ] 谓词下推生效（EXPLAIN 验证索引命中）
- [ ] loom 方言输出逻辑 SQL
- [ ] 多租户隔离生效（e2e 验证）
- [ ] catalog 缓存命中 < 1µs
- [ ] 端到端 pg 查询 < 10ms
- [ ] 全部现有测试不退化
- [ ] benchmark 套件就位

## 6. 文档更新

实现过程中需同步更新：

- `loom/docs/guide/` 增加 catalog 投影章节
- `kql/docs/STATUS.md` 增加 loomcatalog 包状态
- `kql/DESIGN.md` 增加 loom 方言与 ext 集成章节
- `kql/claude.md` 更新架构图

## 7. 时间预估（粗略，仅参考）

| 阶段 | 工作量 |
|---|---|
| 0 | 小（loom 侧 emitter） |
| 1 | 中（catalog 骨架 + ColBinding 改动） |
| 2 | 大（核心 emit 算法） |
| 3 | 小（loom 方言，复用阶段 2 代码） |
| 4 | 中（多租户 + 缓存） |
| 5 | 中（benchmark + e2e） |

阶段 2 是主体工作量，建议拆 2a-2e 子阶段逐步 review。

## 8. 开放议题（留待实现期决策）

- catalog 文件监听 vs 显式重载（热重载机制）
- JoinPlan 缓存的哈希算法（xxHash vs FNV）
- loom 方言 SQL 是否需要正式的 parser（让 loom SQL 可反向解析为 KQL）
- 跨 entity 查询（JOIN 多个 entity）的 ext 处理
- ext 字段的运行时类型校验（enum 值合法性）

这些不阻塞主线实现，可在对应阶段启动前再决策。
