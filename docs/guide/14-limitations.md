# 已知局限与路线

## v0.2.0 已知局限

| 项 | 说明 |
|---|---|
| 诊断无行号 | 错误硬编码为 `1:1`，YAML 位置追踪未实现 |
| FK 渲染原始 | `foreign_keys.ref_table` 原样输出，`entity:` refs 不解析为 `primary_table` |
| 形态 C 重命名未实现 | using 仅支持 A（`ns.*`）与 B（`ns.Name`）；冲突时用全限定名绕开 |
| mixin using 化未实现 | mixin include 仍用 `- include: mixin:...`（v2.1 候选） |
| 未实现的命令 | `fmt`（格式化）、`lift`（反向提炼）、`project atlas-yaml` |

## 后续路线

- YAML 位置追踪 → 精确 line:col 诊断
- FK 跨 kind 解析（`entity:` → `primary_table`）
- using 形态 C（重命名）——解决短名冲突，无需回退全限定名
- mixin using 化——把 `- include: mixin:...` 纳入 using 体系（v2.1 候选）
- 共享目录候选——v0.2.0 取消了 `_shared/`，所有 kind 落模块目录；若实践中跨模块
  复用频繁、需要"位置即意图"的强提示，可重新引入 `_shared/` 作为可选风格
  （思路见 `docs/design/2026-06-18-shared-and-value-type-notes.md` §a）
- 方言插件机制——支持注册第三方 `dialects/<name>.ts`（达梦、OceanBase 等），
  而非在 schema 里描述方言映射（同上设计文档 §c 已否决 schema 自描述方案）
- `loom fmt` — 字段排序、key 顺序固定、缩进统一
- `loom lift` — 从 atlas-yaml/v2 物理格式反向提炼 design schema 骨架
- `loom project atlas-yaml` — 桥接到 atlas 生态
- `loom project prisma` / `loom project openapi`（更后续）
