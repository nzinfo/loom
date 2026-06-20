# 快速上手：第一个 Schema

我们从最小可运行的例子开始，逐步加料。完整版见
[15 完整示例](./15-full-example.md)。

## 创建项目骨架

```sh
mkdir -p my-schema/platform/base/core
touch my-schema/platform/base/core/string.type.yaml
```

kind 由文件扩展名决定（详见 [01 目录与身份](./01-layout-and-identity.md)），
所以不需要 kind 子目录——文件扁平地放在模块下。

## 写标量类型文件

标量（scalar）是 loom 的原子词汇表，每个标量是一个独立的 `.type.yaml` 文件：

```yaml
# my-schema/platform/base/core/string.type.yaml
version: loom-schema/v2
name: string
form: scalar
description: var-length string
properties:
  - name: max_length
    type: integer
    required: true
```

```yaml
# my-schema/platform/base/core/bigint.type.yaml
version: loom-schema/v2
name: bigint
form: scalar
description: 64-bit integer
properties: []
```

`type` 是统一的类型定义 kind，由 `form` 字段区分 scalar / struct / enum 三态。
完整说明见 [03 type](./03-base-types.md)。

## 写 manifest.module.yaml

```yaml
# my-schema/platform/base/core/manifest.module.yaml
version: loom-schema/v2
system: base
module: core
physical_schema: base_core
description: core module
```

`physical_schema` 决定了这个模块下所有表的物理 schema 前缀（PG schema / MySQL database）。
详见 [07 entity 与 module_manifest](./07-entity-and-manifest.md)。

## 写第一张表

```yaml
# my-schema/platform/base/core/users.table.yaml
version: loom-schema/v2
name: Users
table:
  name: users
  extension:
    strategy: none
fields:
  - name: id
    type: bigint
    required: true
  - name: email
    type:
      ref: string
      args: { max_length: 254 }
    required: true
primary_key: [id]
```

v2 用单一 `type:` 键表达字段类型（替代 v1 的 `base` / `ref` 互斥键）：
单段短名（如 `bigint`、`string`）解析到 scalar 标量；三段全限定名
（如 `base.core.Email`）解析到 value_type 节点。

`type:` 支持两种形式：
- **简写**：裸字符串 `type: bigint`、`type: base.core.Email`
- **详写**（type descriptor）：`type: { ref: string, args: {...}, meta: {...} }`
  ——所有标量参数（`max_length`、`precision`、`scale`、`pattern`）都收拢到
  `args`，不再写在 field 顶层

详见 [04 value_type](./04-value-type.md) §单一 type: 键。

## 校验

```sh
loom check my-schema/
```

无输出 = 通过。退出码 0。诊断管线详见 [11 加载管线](./11-pipeline.md)。

## 投影

```sh
loom project sql --dialect pg my-schema/
```

输出（节选）：

```sql
CREATE TABLE base_core.users (
  id BIGINT NOT NULL,
  email VARCHAR(254) NOT NULL,
  PRIMARY KEY (id)
);
```

试试其他方言：

```sh
loom project sql --dialect mysql my-schema/    # DECIMAL 不带方言语义
loom project sql --dialect sqlite my-schema/   # 主键自增、CHECK IN 等
```

CLI 完整参考见 [10 cli](./10-cli.md)。
