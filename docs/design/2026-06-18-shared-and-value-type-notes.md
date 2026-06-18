# 设计记录：`_shared/` 边界、`value_type` 命名、方言映射归属

- 日期：2026-06-18
- 状态：思路归档（部分已落实于 v0.2.0 USER_GUIDE，部分作为后续候选）
- 关联 spec：`docs/specs/2026-06-18-loom-v2-type-system.md`
- 关联用户文档：`docs/USER_GUIDE.md` §2.1、§6

本文记录 v0.2.0 在三个相邻问题上曾经考虑过的几条路线、当前选择与理由，供未来
回头审视时参考。它**不是用户文档**——用户侧的最终约定以 USER_GUIDE 为准。

---

## (a) `_shared/` 是"共享 mixin 目录"还是"共享物总目录"？

### 背景

最初 v1/v2 草案把 `_shared/` 当成"跨模块复用的 mixin 专用目录"
（`<system>/_shared/mixin/<name>.yaml`）。讨论中提出：`_shared/` 这个名字本身
暗示的是**位置语义**（"跨模块共享"），并不天然专属 mixin——跨模块复用的
`value_type`（`Email`、`Money`）按同样语义也该能放进来。

### 两条候选路线

- **路线 A**：`_shared/` 作为**跨模块共享物的总目录**，按 kind 分子目录
  （`_shared/mixin/`、`_shared/value_type/` 等）。身份形式统一为
  `<sys>._shared.<Name>`。
  - 优点：一个语义（"跨模块复用"）一个目录，位置即意图。
  - 代价：共享 value_type 不在默认导入的 `base.core.*` 名下，引用方需显式 `using`。

- **路线 B**：取消 `_shared/`，所有节点一律按 kind 落到模块目录下
  （`base/core/mixin/audit.yaml`、`base/core/value_type/email.yaml`）。
  - 优点：与 v2"统一名字空间"哲学最贴合；默认 `base.core.*` 直接覆盖 mixin 之外的
    所有共享物；身份形式统一为 `<sys>.<mod>.<Name>`。
  - 代价：跨模块复用只能靠约定（"放在 `base/core` 下供别的模块 using"），没有显式的
    位置标记。

### v0.2.0 选择

**采用路线 B**（USER_GUIDE §2.1 已据此更新：布局图删除 `_shared/`，mixin 落到
`base/core/mixin/`，身份形如 `mixin:base.core.Audit`）。

理由：

1. v2 的核心动作是**收敛名字空间**（spec §0–§2）——把类型劈成 `base`/`ref` 的 v1
   旧账已经清掉，布局层面继续保留一个"特殊位置"反而显得不一致。
2. mixin 在身份系统里本就**独立**（不参与 `type:` 引用，只通过 `- include:` 消费），
   它的物理落点无需和"value_type 是否共享"耦合；让所有 kind 在布局上地位平等，
   认知负担最低。
3. 跨模块复用真正的载体是 **`using` 导入** + **module_manifest `exports`**，不是
   目录名。"是否共享"由模块边界 + 导出声明表达，比一个 `_shared/` 目录更准确。

路线 A 的方案作为**未来扩展候选**留底：若实践发现需要"位置即意图"的强提示
（例如大型多团队 monorepo），可在不破坏 v0.2.0 约定的前提下，新增 `_shared/`
作为可选风格——届时本文档应同步更新。

---

## (b) `value_type` 这个名字要不要改？

### 候选

| 候选 | 优点 | 缺点 |
|---|---|---|
| `value_type`（现） | 类型论准确；与 `entity`（引用语义）形成对偶 | 对非类型论背景的人略学术 |
| `value_object` | DDD 术语，业务侧熟悉 | "object" 在 DB 语境易误读；失去"是 type 的一种"这层 |
| `datatype` / `data_type` | UML/SQL 友好 | 与 `base_types` 标量（也是 datatype）撞义 |
| `typedef` | C 风格，表达"用户定义类型" | 偏 C 语感 |
| `type` | 最简 | 与字段 `type:` 键、`base_types` 都重名 |

### v0.2.0 选择

**保留 `value_type`**。理由：

1. v2 spec §2.1 的核心论点是"`kind: value_type` 自身就声明了'我是类型'"——名字
   `value_type` 在这里承担**类型论语义**（值类型 vs 引用类型）。它与 `entity`
   （有 identity、引用语义）形成**精确对偶**，换名会稀释这层论点。
2. v2 已让 `base_types` 标量与 `value_type` 节点**地位平等**（spec §2.2）：都是
   "类型"，区别仅在来源（注册表 vs 节点表）。`value_type` 这名字正好表达"由用户
   定义的、值语义的类型节点"，与"由系统注册表提供的标量"形成自然分工。
3. `type` 太泛；`datatype` 与 base_types 标量撞义；`value_object` 失去类型论对偶；
   `typedef` 偏 C 语感——均有明显短板。

如未来要在面向非技术读者的文档里柔化措辞，可在解释性段落用"value object
（值对象）"作为通俗别名，但 **schema 关键字 `kind: value_type` 不变**。

---

## (c) 数据库方言映射放哪——schema 自描述还是 projection 翻译？

### 背景

曾考虑"让 base_types / value_type 在 schema 里自带方言映射表"，例如：

```yaml
# 假想（未采纳）
scalars:
  - name: json
    dialects:
      pg: JSONB
      mysql: JSON
      sqlite: TEXT
```

这样 schema 一次性描述所有方言，projector 只做查表。

### v0.2.0 选择

**坚持 projection 方案**：方言映射留在 projector 内（
`packages/core/src/projector/dialects/pg.ts` 的 `pgType()` 等函数），schema 不描述
方言。理由：

1. base_types → SQL 方言的映射是**稳定的工程知识**（`integer`→`INTEGER`、
   `string`→`VARCHAR`、`datetime`→`TIMESTAMPTZ`），不是业务知识，不该污染逻辑模型。
2. loom 的分层哲学是"逻辑模型 → projector → 物理模型"。把方言塞回 schema 等于把
   物理细节漏到逻辑层，破坏分层。
3. 真正需要 schema 介入的是**类型约束**（`max_length`、`precision`、`scale`、
   `enum values`）。这些已通过 base_types 属性传到 projector，由 projector 据此生成
   `VARCHAR(255)` / `NUMERIC(18,4)`。**约束走 schema、翻译走 projector**，职责分明。
4. 方言爆炸场景（用户要支持 loom 未内置的方言，如达梦、OceanBase）应通过
   **projector 插件机制**（注册新的 `dialects/<name>.ts`）扩展，而不是让每个 schema
   都自带一份方言表。前者集中、可测试；后者分散、易出错。

### 后续候选

- 设计 `Dialect` 插件接口（输入 PhysicalModel + 选项，输出 SQL 字符串）。
- 在 `loom project sql --dialect <name>` 里支持加载第三方 dialect 插件
  （npm 包约定名 `loom-dialect-<name>` 或类似）。
- 不在 v0.2.x 范围内；先观察实际需求。

---

## 与 USER_GUIDE 的对应

| 本文档章节 | USER_GUIDE 落点 |
|---|---|
| (a) `_shared/` 取消，mixin 走模块目录 | §2.1 布局图、§6.1 路径与身份 |
| (b) `value_type` 保留 | §5（隐含；无显式"为什么叫 value_type"段落，必要时回查本文） |
| (c) 方言映射走 projection | §8.4 投影输出、§12.3 `project sql`（隐含；实现细节在源码） |

USER_GUIDE 只承载**结论与用法**；本文承载**为什么**。
