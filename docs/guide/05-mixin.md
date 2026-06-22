# 字段复用：struct 引用 + column flatten

loom 没有 "mixin" 这个独立 kind。字段组复用通过 **struct 引用 + `column: ''`（flatten）**
实现——一个 struct 类型（如 `Audit`）被 `type:` 引用，`column: ''` 让它的字段直接插入
宿主，不加前缀。

## 定义：Audit 是一个普通 struct

```yaml
# platform/base/core/audit.type.yaml
version: loom-schema/v2
name: Audit
form: struct
fields:
  - name: created_at
    type: datetime
    required: true
  - name: updated_at
    type: datetime
    required: true
```

Audit 就是一个有两个字段的 struct——和 Money、Email 没有本质区别。

## 引用：column 控制投影方式

### flatten（column: ''）— 字段直接插入

```yaml
# users.table.yaml
fields:
  - name: audit
    type: base.core.Audit
    column: ''                # ← 空字符串 = flatten
  - name: id
    type: bigint
```

投影（flatten，无前缀，用 Audit 内部字段名）：
```sql
created_at TIMESTAMPTZ NOT NULL,
updated_at TIMESTAMPTZ NOT NULL,
id BIGINT
```

### prefix（默认）— 带前缀

```yaml
fields:
  - name: audit
    type: base.core.Audit     # column 省略 → 默认 = name "audit"
```

投影（带前缀）：
```sql
audit_created_at TIMESTAMPTZ NOT NULL,
audit_updated_at TIMESTAMPTZ NOT NULL
```

## column 字段的完整语义

| column 值 | 语义 | 投影 |
|---|---|---|
| 省略 | 默认 = name | name 作列名（scalar/newtype）或前缀（multi-field） |
| `''`（空字符串） | flatten | 目标字段用自己的名字，不加前缀 |
| `'foo'` | 覆盖 | 用 `foo` 作列名或前缀 |

```yaml
# 覆盖物理列名（遗留 DB 命名）
- name: balance
  type: base.core.Money
  column: bal                 # → bal_amount, bal_currency_code
```

## 为什么不再需要独立的 mixin kind

mixin 和 struct 的唯一区别是投影方式（flatten vs prefix）。这个区别用 `column: ''` 表达
就够了——不需要独立 kind、不需要 `include:` 语法。统一到 `type:` 引用后：

- FILE_KIND 从 5 降到 **4**（type / table / entity / extension_fields）
- `include:` 语法删除（统一用 `type:`）
- `fieldOrInclude` union 简化为纯 field
- mixin 的循环检测、递归展开等逻辑删除（struct 引用由 link 的类型解析统一处理）

## 迁移：从 v1 的 include 语法

```yaml
# 旧（v1）
- include: mixin:base.core.Audit

# 新
- name: audit
  type: base.core.Audit
  column: ''
```

详见 [03 type](./03-base-types.md) §form: struct。
