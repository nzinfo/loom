# 06 · CLI 命令

loom CLI 是操作 schema 的**唯一接口**——无论是查询、校验、投影还是修改，都通过 CLI
完成。CLI 封装了文件路径、命名约定、格式化规则，调用方（人或 AI agent）不需要知道
YAML 文件放在哪、怎么命名。

> loom 核心引擎是纯编译器（只读），不写文件。所有文件读写由 CLI 层负责。

## 全局选项

| 选项 | 说明 |
|---|---|
| `--json` | 所有命令输出 JSON（机器可读，供 AI agent 解析） |
| `--quiet` | 抑制非必要输出 |

## version

```sh
loom version
```

## 校验

### check

```sh
loom check <path>
```

加载 + 校验整个 schema 树。通过无输出，退出码 0。失败输出诊断信息。

```sh
loom check --json my-shop/     # JSON 格式诊断
```

## 列表查询

列出 schema 中的各类节点。

```sh
loom list types <path>                 # 所有类型（scalar/struct/enum）
loom list tables <path>                # 所有表
loom list entities <path>              # 所有实体
loom list extensions <path>            # 所有扩展字段文件（entity → groups → owner）
```

`--json` 输出示例（`loom list entities --json my-shop/`）：

```json
[
  { "identity": "entity:shop.core.Product", "owner": "platform",
    "primary_table": "table:shop.core.Products", "business_keys": ["name"] }
]
```

## 详情查询

查看单个节点的完整信息。

```sh
loom show type <path> <name>            # 类型详情（form/fields/properties/variants）
loom show table <path> <name>           # 表详情（列/主键/索引/FK/扩展策略）
loom show entity <path> <name>          # 实体详情（base 字段 + ext 分组 + 来源）
loom show graph <path>                  # 依赖图（谁引用谁）
```

`<name>` 是身份引用，如 `type:shop.core.Money`、`entity:shop.core.Product`。

`loom show entity` 等价于之前的 `loom fields`：

```
entity: shop.core.Product
table: products_base

── base fields ──────────────────────────
  id                       bigint
  name                     string(255)
  ...

── group: inventory (ext:provider-a) ────
  sku                      string(64)
  ...
```

## 投影

### project sql

```sh
loom project sql --dialect <d> [--out <f>] [--physical-schema <mod>=<name>]... <path>
```

投影为 SQL DDL。

| 选项 | 说明 |
|---|---|
| `--dialect` | `pg` / `mysql` / `sqlite`（必填） |
| `--out <file>` | 写入文件（省略时输出到 stdout） |
| `--physical-schema <mod>=<name>` | 覆盖物理 schema 名（可重复） |

### project model

```sh
loom project model [--dialect <d>] <path>
```

输出物理模型（JSON 格式），不走 SQL。展示表、列、索引、外键、扩展字段的完整物理
结构。供工具链（如 atlas 桥接、ORM 生成）消费。JSON schema 详见
[`project-model-schema.md`](../project-model-schema.md)。

```sh
loom project model --json my-shop/
```

## 初始化项目

### init

```sh
loom init <path> --system <sys> --module <mod>
```

创建一个新的 loom schema 项目骨架：目录结构 + 全部 18 种内置标量 + 一个示例表/实体。

```sh
loom init my-shop/ --system shop --module core
```

生成：

```
my-shop/
└── platform/
    └── shop/
        └── core/
            ├── bigint.type.yaml          ← 全部 18 种内置标量
            ├── string.type.yaml
            ├── decimal.type.yaml
            ├── ...（全部标量）
            ├── items.table.yaml          ← 示例表（可删）
            └── item.entity.yaml          ← 示例实体（可删）
```

| 选项 | 说明 |
|---|---|
| `--system <name>` | 系统名（如 `shop`） |
| `--module <name>` | 模块名（如 `core`），默认 `core` |
| `--no-example` | 不生成示例表/实体 |
| `--force` | 目录已存在时覆盖 |

初始化后所有内置标量立即可用，可以直接 `loom check my-shop/` 验证，或删掉示例
文件开始自定义。

## 创建节点

```sh
loom new type <path> <name> [--form scalar|struct|enum]
loom new table <path> <name>
loom new entity <path> <name> --table <table>
loom new extension <path> --entity <entity> [--group <group>]
```

CLI 负责正确的文件路径、命名、`version` 头、`using` 声明。

```sh
# 创建一个结构体类型
loom new type my-shop/ shop.core.Address --form struct

# 创建一张表
loom new table my-shop/ shop.core.Orders

# 创建实体，关联到表
loom new entity my-shop/ shop.core.Order --table table:shop.core.Orders

# 创建扩展字段文件
loom new extension my-shop/ --entity entity:shop.core.Order --group billing
```

## 编辑字段

给 table、struct type、或 extension 加/删字段：

```sh
# 加字段
loom add field <path> <target> <name> <type> [options]

# 删字段
loom rm field <path> <target> <name>
```

`<target>` 是节点身份引用（如 `table:shop.core.Orders`、`type:shop.core.Money`、
`extension:entity:shop.core.Order::billing`）。

```sh
# 给表加字段
loom add field my-shop/ table:shop.core.Orders total shop.core.Money --required

# 给结构体加字段
loom add field my-shop/ type:shop.core.Address city string --args max_length=64

# 给扩展组加字段
loom add field my-shop/ extension:entity:shop.core.Order::billing tax_id string

# 删字段
loom rm field my-shop/ table:shop.core.Orders total
```

| `add field` 选项 | 说明 |
|---|---|
| `--required` | NOT NULL |
| `--unique` | UNIQUE |
| `--args key=value` | 类型参数（如 `--args max_length=255 precision=18 scale=4`） |
| `--column <name>` | 物理列名覆盖 |

## 调整字段顺序

字段的声明顺序决定了投影后 SQL 列的顺序（影响 `SELECT *` 列序、diff 友好性）。
提供两种调整方式：

### move field——移动单个字段

```sh
loom move field <path> <target> <field> --after <other>
loom move field <path> <target> <field> --before <other>
loom move field <path> <target> <field> --first
loom move field <path> <target> <field> --last
```

```sh
# 把 total 移到 name 后面
loom move field my-shop/ table:shop.core.Orders total --after name

# 把 created_at 移到最前
loom move field my-shop/ type:shop.core.Audit created_at --first
```

### order fields——一次性重排全部字段

给出期望的完整字段顺序，CLI 据此重排。适合 AI agent 批量调整——先 `show` 拿到
当前顺序，调整后一次性设定：

```sh
loom order fields <path> <target> <field1> <field2> <field3> ...
```

```sh
# 重新排列 Orders 的字段顺序
loom order fields my-shop/ table:shop.core.Orders id name total status created_at
```

必须列出全部字段（不能遗漏或多余），否则报错——防止意外丢失字段。

## 删除节点

```sh
loom rm type <path> <name>
loom rm table <path> <name>
loom rm entity <path> <name>
loom rm extension <path> --entity <entity> [--group <group>]
```

删除前 CLI 会检查是否有其他节点引用它（依赖图），有则报错。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 加载 / 校验失败 |
| 2 | 投影失败 |
| 3 | 写入失败（文件冲突、权限等） |
| 64 | 用法错误 |
