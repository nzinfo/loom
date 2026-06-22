# loom 用户指南

loom 是面向 ERP 的 design schema DSL——以业务语义描述数据模型，
确定性投影为多方言 SQL DDL。

本指南已按主题拆分到 `docs/guide/` 下，下方为索引。完整设计规范见
`docs/specs/`。

## 索引

### 入门

- [00 总论](./guide/00-overview.md) — 设计哲学、安装、30 秒体验
- [01 目录与身份](./guide/01-layout-and-identity.md) — 目录布局、owner 维度、identity 推导
- [02 速览](./guide/02-quickstart.md) — 最小 schema 到 SQL

### 数据类型

- [03 base_types](./guide/03-base-types.md) — 标量目录
- [04 value_type](./guide/04-type-refs.md) — 语义类型包装、using、type_parameters

### 模型构件

- [05 mixin](./guide/05-mixin.md) — 字段组复用
- [06 table](./guide/06-table.md) — 表定义、三种扩展策略、variants、索引、外键
- [07 entity 与 module_manifest](./guide/07-entity-and-manifest.md) — 业务身份、物理 schema 归属
- [08 extension_fields](./guide/08-extension-fields.md) — 自定义字段模板、多 owner 叠加

### 引用与加载

- [09 `$ref` 引用语法](./guide/09-refs.md) — 类型引用 vs 身份引用
- [10 CLI](./guide/10-cli.md) — 命令参考
- [11 加载管线](./guide/11-pipeline.md) — 4 阶段与诊断

### 工程化

- [12 编程式调用](./guide/12-programmatic.md) — FileSystem 注入、`load()`、`expandTables()`
- [13 CI / Git](./guide/13-ci.md) — GitHub Actions、pre-commit、diff-stability
- [14 已知局限与路线](./guide/14-limitations.md) — v0.2.0 局限 + 后续路线

### 参考

- [15 完整工作示例](./guide/15-full-example.md) — 全套 YAML + 黄金 SQL
- [16 错误速查](./guide/16-errors.md) — 错误类别表

## 更多资料

- **设计规范**：`docs/specs/2026-06-17-loom-design.md`（v1 完整设计）
- **v2 类型系统**：`docs/specs/2026-06-18-loom-v2-type-system.md`
- **v2 owner 维度**：`docs/specs/2026-06-18-loom-v2-owner-dimension.md`
- **设计记录**：`docs/design/`
