# loom 总论

> loom 是一个**前向设计（design-first）**的 Schema 描述语言引擎：你用 YAML 描述
> 设计模型（实体、值类型、混入、表、扩展字段），loom 把它投影成可直接执行的物理
> SQL DDL（PostgreSQL / MySQL / SQLite）。
>
> 核心理念：**先建模，再投影**。设计层关注语义（"用户有邮箱、有余额"），投影层
> 关注物理实现（"邮箱是 VARCHAR(254)、余额是 NUMERIC(18,4)，扩展字段走 sidecar
> EAV 表 + 透视视图"）。

## 这套文档怎么读

按主题拆成多篇，建议顺序：

| 篇 | 主题 | 适合 |
|---|---|---|
| [00 总论](./00-overview.md) | 设计理念、安装、三十秒体验 | 第一次接触 loom |
| [01 目录与身份](./01-layout-and-identity.md) | 路径即身份 + owner 三层归属 | 了解 schema 树怎么放 |
| [02 快速上手](./02-quickstart.md) | 最小可运行 schema → SQL | 跑通第一个例子 |
| [03 type](./03-base-types.md) | 类型定义 | scalar / struct / enum 三态 |
| [04 类型引用与 using](./04-type-refs.md) | 类型引用语法、using 导入、Type Descriptor | 复用业务类型 |
| [05 字段复用](./05-mixin.md) | struct 引用 + column flatten | 横切关注点（审计字段等） |
| [06 table](./06-table.md) | 表定义、扩展策略、枚举/索引/外键 | 落物理表结构 |
| [07 entity](./07-entity.md) | 业务身份层 + 物理归属 | ERP 业务建模 |
| [08 extension_fields](./08-extension-fields.md) | 自定义字段模板（多 owner 叠加） | 租户/扩展字段 |
| [09 refs](./09-refs.md) | 类型引用 vs 身份引用 | 跨文件引用语义 |
| [10 cli](./10-cli.md) | 命令行参考 | 工具链 |
| [11 加载管线](./11-pipeline.md) | 4-pass 管线 + 诊断 | 排错、CI |
| [12 编程式调用](./12-programmatic.md) | FileSystem 注入、取物理模型 | 嵌入其他系统 |
| [13 ci](./13-ci.md) | GitHub Actions、diff-stability | CI 集成 |
| [14 已知局限](./14-limitations.md) | v0.2.0 局限 + 路线 | 评估可用性 |
| [15 完整示例](./15-full-example.md) | 黄金固件逐文件解析 | 对照真实 schema |
| [16 错误速查](./16-errors.md) | 诊断类别表 | 查错 |

## 设计理念

### 前向设计，单向投影

loom 只做"设计 → 物理"单向投影，不做反向（`lift` 命令是未来计划）。理由：

- **避免双源真理**：物理 schema 是设计 schema 的产物，而非独立事实
- **diff 可预测**：设计 schema 改了，物理 schema 的 diff 可预测、可 review
- **与 atlas 正交**：atlas 承担 atlas-yaml/v2（物理描述格式），loom 承担
  loom-schema/v2（设计描述格式），两者通过 CLI 桥接

### 路径即身份

不需要在文件头声明 system/module/kind/name——它们由文件路径推导（详见
[01 目录与身份](./01-layout-and-identity.md)）。这让 schema 树可被工具扫描、
可 diff、可重构，而不依赖文件内容的自指声明。

### 三层 owner 归属

v2 把节点归属分成 platform（平台权威）、ext（第三方扩展包）、tenant（租户定制）
三层。归属从目录顶层前缀推断，**不在文件内容里声明**（详见
[01 目录与身份](./01-layout-and-identity.md) §owner 维度）。

## 安装

### 环境要求

- Node.js ≥ 20
- pnpm（推荐 v9+）

### 安装步骤

```sh
cd /path/to/loom
pnpm install
pnpm -r run build
```

loom 是一个 pnpm 工作区，包含两个包：

- `@loom/core` — 引擎（环境无关，不依赖 `node:fs`；文件系统通过依赖注入）
- `@loom/cli` — Node.js 命令行包装

## 三十秒体验

如果只想看看输出长什么样，直接跑仓库自带的黄金固件测试：

```sh
pnpm --filter @loom/core test
```

`packages/core/tests/golden/base_schema.pg.sql` 是真实投影输出，下文会逐步拆解
（详见 [15 完整示例](./15-full-example.md)）。

## 相关文档

- **设计规范**：`docs/specs/2026-06-18-loom-v2-type-system.md`（v2 类型系统）、
  `docs/specs/2026-06-18-loom-v2-owner-dimension.md`（v2 owner 维度）。
  （`2026-06-17-loom-design.md` 是 v1 历史快照，已加废弃标记，不反映当前实现。）
- **设计记录**：`docs/design/*.md`（实施过程中的关键决策）
- **实施计划**：`docs/superpowers/plans/*.md`
