# mixin：字段组复用

当一组字段在多张表里重复（如标准审计四字段 `created_at`/`updated_at`/`created_by`/
`updated_by`），提取成 mixin。

## 定义 mixin

```yaml
# platform/base/core/mixin/audit.yaml
version: loom-schema/v2
kind: mixin
name: Audit
display_name: 审计字段组
fields:
  - { name: created_at, type: datetime, required: true }
  - { name: updated_at, type: datetime, required: true }
```

mixin 与其他 kind 一样落在**模块目录**下（`<system>/<module>/mixin/`），身份形如
`mixin:base.core.Audit`。跨模块复用时由目标模块 `using` 导入。

## 在 table 里 include

```yaml
# platform/base/core/table/users.yaml
fields:
  - name: id
    type: bigint
    required: true
  - include: mixin:base.core.Audit        # 整组插入到当前位置
  - name: email
    type: base.core.Email
    required: true
    unique: true
```

加载器遇到 `include:` 把目标 mixin 的 fields **就地展开**到当前位置（保持顺序），
结果就像直接写出来一样。

## 嵌套与循环

mixin 也可以 include 其他 mixin（嵌套展开）。加载器递归展开 + 检测环——
`A include B, B include A` 会报 `cycle` 错误。

mixin **物理上落到主表**（展开为列），与运行时 sidecar EAV 完全正交。
扩展策略（见 [06 table](./06-table.md)）和 mixin 是正交的两条线。
