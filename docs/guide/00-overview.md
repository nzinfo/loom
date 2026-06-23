# loom 使用手册

loom 是面向 ERP 的前向设计 Schema DSL：用 YAML 描述业务模型，确定性投影为多方言
SQL DDL（PostgreSQL / MySQL / SQLite）。

**核心理念：先建模，再投影。** 你关注"产品有名称、有价格"，loom 负责把它变成
`VARCHAR(255) NOT NULL`、`NUMERIC(18,4)`。

## 30 秒体验

```sh
# 检视一个 entity 的全部字段（base + 扩展）
loom fields examples/product/ entity:shop.core.Product

# 投影为 PostgreSQL DDL
loom project sql --dialect pg examples/product/
```

## 本手册结构

| 篇 | 主题 |
|---|---|
| [01 快速上手](./01-quickstart.md) | 从零创建一个 schema，到投影出 SQL |
| [02 类型系统](./02-types.md) | 标量、结构体、枚举；类型引用与 using 导入 |
| [03 表与实体](./03-table-entity.md) | table 物理结构、entity 业务身份、扩展策略 |
| [04 扩展字段](./04-extension-fields.md) | JSONB 扩展组、group/scope、多 provider 叠加 |
| [05 完整示例](./05-full-example.md) | `examples/product/` 全文解读 |
| [06 CLI 命令](./06-cli.md) | version / check / fields / project |

> 完整技术规范见 [`SPEC.md`](../SPEC.md)。本手册是用户向的教程，不暴露实现细节。
