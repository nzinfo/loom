# kql × loom 扩展集成设计

**日期**：2026-06-27
**状态**：设计阶段（未实现）
**范围**：让 kql 能查询带扩展字段（ext）的 loom entity，且扩展的装/卸完全在 kql/catalog 层，不依赖 DB 端 view 物化

---

## 1. 背景与动机

loom 把 entity 的扩展字段（来自不同 owner）落到两种物理存储：
- `sidecar_jsonb`：共享 `<base>_ext` 表，按 `source` 列区分 owner/group，字段是 JSONB `values` 文档的 key
- `new_table`：独立物理表，字段是真实列

loom 自己会投影出 pivot view（`CREATE VIEW`）把 base + ext 拼成扁平视图。但**用 DB view 给 kql 看有硬伤**：

- 每装/卸一个 ext 都要 `CREATE OR REPLACE VIEW`，DB 端 schema 漂移
- 一个 view 只能装一组 ext，多 owner 冲突
- 多租户隔离困难（不同 tenant 看不同列集需要不同 view）
- view 把 join 写死，kql 优化器失去物理细节优化空间

**结论**：放弃 view 物化路线（旧方案 A），改为**让 kql 在 emit 阶段把 ext 语义直接编进 SQL**，loom 退化为 kql 的 schema provider + 第四个方言。

## 2. 设计目标

1. **灵活装配**：装/卸 ext 只改 yaml 文件 + 重载 catalog，不动 DB schema
2. **多租户隔离**：同一 entity 名按 context 暴露不同列子集，互不可见
3. **查询执行性能优先**（用户明确）：生成的 SQL 必须跑得快
   - 谓词下推到 JOIN 之前（减少 join 行数）
   - JSONB 提取用 GIN 友好表达式
   - JOIN 复用（同 sourceHash 的多列共享一个 JOIN）
   - 复合 PK 正确处理
4. **kql 内部环节快**：catalog 加载/bind/emit 低延迟
5. **零 DB view 依赖**：DB 只要有 base + ext 原表即可

## 3. 非目标

- 不改 loom 的 ext 解耦策略设计（`2026-06-24-ext-strategy-decoupling.md` 不变）
- 不让 kql 解析 loom 的 `*.table.yaml` / `*.ext.yaml` 原始格式（kql 只消费投影产物 JSON）
- 不实现 mv-expand/parse 等 PostProc 的 ext 适配（后续工作）
- 不做 ext 字段的运行时校验（如 enum 值合法性），那是应用层职责

## 4. 架构总览

```
┌─────────────────── loom (TypeScript) ───────────────────┐
│                                                          │
│   *.table.yaml + *.ext.yaml (按 owner 分目录)            │
│            │                                             │
│            │  现有 loader/link/projector 管线            │
│            ▼                                             │
│   IR + PhysicalModel                                     │
│            │                                             │
│            │  ★ 新增: loom-schema.json emitter           │
│            ▼                                             │
│   loom-schema.json (扁平 catalog, 方言无关)              │
│                                                          │
└──────────────────────┬───────────────────────────────────┘
                       │ 文件 / stdin
                       ▼
┌─────────────────── kql (Go) ────────────────────────────┐
│                                                          │
│   kql --loom-schema ./out/ --loom-owners ...  'KQL...'   │
│            │                                             │
│            │  ★ LoomCatalog 加载 + context 过滤          │
│            ▼                                             │
│   LoomCatalog (按 tenant/owner 过滤后的 ext 子集)        │
│            │                                             │
│            │  实现 binder.SchemaProvider                 │
│            ▼                                             │
│   Binder: ColBinding 带 Origin 元数据                    │
│   (base 列 / sidecar JSONKey / new_table 物理列)         │
│            │                                             │
│            │  optimizer (谓词下推/列裁剪, 不感知 ext)    │
│            ▼                                             │
│   Emit (按方言展开)                                      │
│     ├─ pg:     LEFT JOIN + jsonb 提取 + source 过滤      │
│     ├─ sqlite: LEFT JOIN + json_extract + source 过滤    │
│     └─ loom:   ★ 新方言, 逻辑扁平形态, 不展开 join       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## 5. 三大支柱

| 支柱 | 文档 | 核心产物 |
|---|---|---|
| ① catalog 交换格式 | [01-loom-schema-catalog.md](01-loom-schema-catalog.md) | loom 投影出 `loom-schema.json` |
| ② kql catalog + 绑定 | [02-loomcatalog-and-binding.md](02-loomcatalog-and-binding.md) | `LoomCatalog` + `ColBinding.Origin` + 多租户过滤 |
| ③ JOIN 注入 + emit | [03-join-injection-and-emit.md](03-join-injection-and-emit.md) | JoinPlan 算法 + 三方言展开规则 |

外加：

| 文档 | 内容 |
|---|---|
| [04-loom-dialect.md](04-loom-dialect.md) | 逻辑 `loom` 方言的文法与用途 |
| [05-performance-strategy.md](05-performance-strategy.md) | 性能决策汇总（执行优先 + kql 内部） |
| [06-landing-plan.md](06-landing-plan.md) | 落地顺序、文件改动清单、测试策略、风险 |

## 6. 关键设计决定（摘要）

| # | 决定 | 理由 |
|---|---|---|
| D1 | kql 消费 `loom-schema.json`，不解析 loom 原始 yaml | 解耦；kql 不依赖 loom 的 TS 类型；loom 升级不破坏 kql |
| D2 | ext 语义留在 `ColBinding.Origin`，binder/optimizer 不感知 | optimizer 现有规则全部复用；ext 是 emit 层关注点 |
| D3 | JOIN 在 emit 阶段按需注入，按 `(table, sourceHash)` 去重 | 同 sourceHash 多列共享 JOIN；不同 sourceHash 强制分离 |
| D4 | 谓词下推到 JOIN ON 子句（sidecar 用 JSONB 谓词） | 性能优先：减少 join 行扫描 |
| D5 | 多租户过滤在 catalog 加载期一次性完成 | 查询期零开销；不可见列直接 KQL001 |
| D6 | 新增 `loom` 方言，仅用于审计/解释/反向消费 | 不执行；提供逻辑视图与物理视图的等价性对照 |
| D7 | kql 内部用 LRU 缓存 catalog 解析结果 + 按 sourceHash 复用 JoinPlan | 减少重复计算 |

## 7. 与现有设计的关系

- 继承 `2026-06-24-ext-strategy-decoupling.md` 的 sidecar_jsonb / new_table 二分策略，不改其语义
- 继承 `2026-06-22-jsonb-extension-groups.md` 的 group/sourceHash 模型
- 替代旧设计讨论中的「DB view 物化」方案（A 方案，已否决）

## 8. 性能优先级声明（贯穿全设计）

用户明确：**两者都要，优先查询执行性能**。当出现以下权衡时，选执行快的：

| 权衡 | 选 |
|---|---|
| kql emit 复杂度 ↑ vs SQL 执行速度 ↑ | 选 SQL 快 |
| catalog 内存占用 ↑ vs 重复 JOIN 计算 ↓ | 选少算 |
| 代码简洁 vs JSONB GIN 友好表达式 | 选 GIN 友好 |
| 通用算法 vs 方言专有优化 | 选专有优化（pg 走 jsonb 路径，sqlite 走 json_extract） |

性能细节集中见 [05-performance-strategy.md](05-performance-strategy.md)。
