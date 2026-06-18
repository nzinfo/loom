# 错误类别速查

诊断按 `category` 分类：

| 类别 | 触发场景 |
|---|---|
| `parse` | YAML 语法错、字段类型错 |
| `version` | version 字段不匹配 |
| `identity` | 路径与文件内自指冲突、identity 重复 |
| `dangling_ref` | `$ref` 目标不存在 |
| `kind_mismatch` | `$ref` 目标 kind 与上下文期望不符 |
| `cycle` | mixin 互相 include 形成环 |
| `schema` | field 缺 `type:`、类型解析失败、属性不在 scalar 的 properties schema 内、extension_fields 同名字段冲突 |
| `semantic` | primary_key 字段非 required、extension_fields 目标 entity 不存在或非 sidecar_eav |
| `project` | 投影器无法落到目标方言 |

错误格式与加载管线详见 [11 加载管线](./11-pipeline.md)。
