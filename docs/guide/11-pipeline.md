# 加载管线与诊断

loom 的加载是确定性的 4 阶段管线，**永不抛异常**——所有错误进入 `diagnostics`。

## 四阶段

```
Pass 0  Discovery     扫描目录，按路径推导 identity + owner
                      extension_fields 允许多 owner 共享 identity（叠加），其他 kind
                      全局唯一
                      错误：路径不符合 platform/ext/tenants 布局、duplicate identity

Pass 1  Parse         YAML → typed struct，校验 version 和 kind
                      extension_fields 文件分流到独立列表（不进 parsed 主表）
                      错误：YAML 语法错、version 不匹配、kind 不在枚举内

Pass 2  Link          解析 $ref，建立 identity→IRNode 映射；从路径推断 owner；
                      聚合 extension_fields 到 IR.extensionFields（按 entity 叠加）
                      错误：dangling_ref、kind_mismatch、cycle（mixin 环）、
                            duplicate extension field（同名冲突）

Pass 3  Validate      语义校验
                      错误：type 缺失或解析失败、属性 schema 不匹配、
                            primary_key 非 required、extension_fields 引用
                            非 sidecar_eav entity、decimal 缺 precision/scale
```

Pass 2 即使有 parse 错误也会运行（为了暴露尽可能多的诊断）。

## 各 pass 的职责细节

### Pass 0 — Discovery

扫描 `basePath` 下所有 `.yaml` / `.yml`，对每个文件调 `pathToIdentity` 推导
identity + owner。结果是一个 `Map<path, DiscoveredEntry>`——key 是路径（永远唯一），
value 携带 `meta.identity`、`meta.owner`。

- **duplicate identity 检测**：两个不同路径推导出同一 identity 且都不是
  extension_fields → 报 `duplicate identity` 错误
- **extension_fields 豁免**：多个 owner 可给同一 entity 写 extension_fields
  （即使文件名相同也允许）→ 它们会在 Pass 2 叠加

### Pass 1 — Parse

读取每个 DiscoveredEntry 的字节，YAML parse + Zod schema 校验。输出两个集合：

- `parsed: Map<identity, AnyFile>` — 节点定义类（value_type / mixin / table / entity
  / module_manifest / base_types），identity 唯一，供 `$ref` 查表
- `extensionFieldsFiles: Array<{ identity, file }>` — 所有 extension_fields 文件，
  identity 可重复

### Pass 2 — Link

- 用 `parsed` 解析所有 `$ref`（`dangling_ref` / `kind_mismatch` / `cycle`）
- 从 DiscoveredEntry.meta.owner 给每个 IRNode 盖 owner 戳
- 展开 mixin `include`（递归 + 环检测）
- 规范化每个 field 的 `type:` 简写为 Type Descriptor 对象
- 聚合 `extensionFieldsFiles` 到 `IR.extensionFields`（按 entity identity 分桶，
  同名字段冲突报错）

### Pass 3 — Validate

跨文件语义校验（Zod 表达不了的）：

- field 的单段短名必须是 base_types 声明的 scalar（`unknown scalar`）
- base_types 标记 required 的 property 必须出现在 `type.args`
- `primary_key` 字段必须是 `required: true`
- extension_fields 的目标 entity 必须存在，且 primary_table 是 `sidecar_eav`

## 错误格式

```
<file>:<line>:<col>: <category>: <message>
```

> **v0.2.0 已知局限**：诊断信息行号列号硬编码为 `1:1`，精确位置追踪未实现。
> 详见 [14 已知局限](./14-limitations.md)。

## 错误不可降级

错误**不可降级为 warning**——`loom check` 失败必须非零退出码，CI 集成依赖这一点。

## 错误类别

诊断按 `category` 分类，常见类别速查见 [16 错误速查](./16-errors.md)。
