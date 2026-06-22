# 已知局限与路线

## v0.2.0 已完成

近期完成的类型系统与布局演进（按时间倒序）：

- **统一短名解析 + 声明名身份**——scalar/struct/enum 走同一条解析路径（查 using 命名空间，
  默认含 `base.core.*`），scalar 不再特殊；身份默认从路径推导，文件声明的 `name:` 覆盖
  （让 scalar 用小写名 `bigint` 而非 `Bigint`）。详见
  `docs/design/2026-06-21-unified-type-kind-notes.md` §11
- **统一 type kind**（`base_types` + `value_type` → `type` + `form` 三态）——消除唯一的
  "集合 kind"特例，标量拆成独立 `.type.yaml` 文件，身份前缀统一为 `type:`。
  详见 `docs/design/2026-06-21-unified-type-kind-notes.md`
- **扩展名编码 kind + 扁平布局**——kind 由文件扩展名决定（`.entity.yaml` 等），
  删除 `entity/` `table/` 等 kind 子目录，文件头不再写 `kind:`
- **owner 三层维度**——platform / ext / tenant 三层归属，从路径顶层前缀推断
- **单一 `type:` 键 + using 导入**——取代 v1 的 `base`/`ref` 互斥键，引入编程语言式
  `using:` 短名导入
- **`_shared/` 取消**——所有 kind 落模块目录，跨模块复用走 `using` + `exports`

## v0.2.0 已知局限

| 项 | 说明 |
|---|---|
| 诊断无行号 | 错误硬编码为 `1:1`，YAML 位置追踪未实现 |
| FK 渲染原始 | `foreign_keys.ref_table` 原样输出，`entity:` refs 不解析为 `primary_table` |
| 形态 C 重命名未实现 | using 仅支持 A（`ns.*`）与 B（`ns.Name`）；冲突时用全限定名绕开 |
| mixin using 化未实现 | mixin include 仍用 `- include: mixin:...`（v2.1 候选） |
| enum 仅简单形态 | 当前 enum 只支持 `variants`（值列表）；Rust 风格带关联数据的代数类型
  是未来方向（`type_parameters` 已对 enum 开放，为其预留） |
| 未实现的命令 | `fmt`（格式化）、`lift`（反向提炼）、`project atlas-yaml` |

## 后续路线

- YAML 位置追踪 → 精确 line:col 诊断
- FK 跨 kind 解析（`entity:` → `primary_table`）
- using 形态 C（重命名）——解决短名冲突，无需回退全限定名
- mixin using 化——把 `- include: mixin:...` 纳入 using 体系（v2.1 候选）
- enum Rust 风格演进——带关联数据的代数类型（设计记录 §3.1 已预留方向）
- 方言插件机制——支持注册第三方 `dialects/<name>.ts`（达梦、OceanBase 等），
  而非在 schema 里描述方言映射（设计文档已否决 schema 自描述方案，坚持 projection）
- `loom fmt` — 字段排序、key 顺序固定、缩进统一
- `loom lift` — 从 atlas-yaml/v2 物理格式反向提炼 design schema 骨架
- `loom project atlas-yaml` — 桥接到 atlas 生态
- `loom project prisma` / `loom project openapi`（更后续）
