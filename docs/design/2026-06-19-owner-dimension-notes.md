# Owner 维度实施记录

> 设计 spec：`docs/specs/2026-06-18-loom-v2-owner-dimension.md`
> 实施计划：`~/.claude/plans/zazzy-spinning-hare.md`（7 个提交）

## 关键设计决策（实施时确认）

### 1. identity 不变，owner 是独立字段

identity 仍是 `kind:sys.mod.Name` 三段；owner 从路径顶层前缀（platform/ext/tenants）
推断，**不在文件内容里声明**。IRNode 加 `readonly owner: Owner`，IR 加
`readonly extensionFields: ReadonlyMap<Identity, ...>`。

### 2. extension_fields 从 nodes map 移除

这是最大的破坏性改动。extension_fields 不进 `IR.nodes`，原因是多 owner 会写出
相同 identity（都给同一 entity 加字段）。改为：

- discovery 仍 discovery extension_fields 文件（path-keyed map，允许多 owner 共享 identity）
- parse 把 extension_fields 分流到独立列表（`extensionFieldsFiles`），不进 `parsed` 主表
- link 聚合 `extensionFieldsFiles` 到 `IR.extensionFields`（按 entity identity 分桶），
  检测同名字段冲突
- validate 从 `IR.extensionFields` 校验（scalar 类型 + 目标 entity 存在 + sidecar_eav）
- projector 直接读 `IR.extensionFields`（不再扫 nodes map）

### 3. discovery 改为 path-keyed map

原本 discovery 用 `Map<identity, entry>`。改为 `Map<path, entry>`（path 永远唯一）。
duplicate-identity 检测仍按 identity 做，但 **extension_fields 豁免**——允许多 owner
给同一 entity 写扩展字段（spec §6.3、§7）。

### 4. parse 输出双集合

`parseAll` 返回 `{ parsed, extensionFieldsFiles }`：

- `parsed: Map<identity, AnyFile>` — 节点定义类（value_type / mixin / table / entity /
  module_manifest / base_types），identity 唯一，供 $ref 查表
- `extensionFieldsFiles: Array<{ identity, file }>` — 所有 extension_fields 文件，
  identity 可重复

### 5. link 的 owner 注入

`LinkOptions.files` 接收 discovery 结果。owner 查找：遍历 files.values() 找匹配
identity 的 entry，取其 `meta.owner`。默认 platform 兜底（当 files 未传时，例如
某些单测直接调 link）。

### 6. tenant 无 kind 目录

tenant 路径 `tenants/<id>/<sys>/<mod>/<name>_fields.yaml`——没有 `extension/` 子目录，
因为 tenant 层只有 extension_fields 一种 kind。pathToIdentity 对 tenant 路径特殊
处理（parseTenant），kind 固定为 extension_fields。

## 与原计划的偏差

计划写的是 7 个独立提交，每个独立可跑测试（"#1 后允许阶段性红，#4 起逐步转绿"）。
实际实施时发现：

- Commit 4（link 聚合）+ Commit 5（validate 改源）+ Commit 6（projector 改源）三者在
  测试层面**强耦合**——extension_fields 从 nodes map 移除后，validate 和 projector
  必须同步改才能保持测试绿。三者分别提交（各自 test 文件独立），但实际是同一个
  语义变更的三面。

- discovery 改 path-keyed + extension_fields 豁免 + parse 分流 extension_fields 是
  Commit 4 的额外工作（计划里没展开），但这是 spec §7"多 owner 叠加"落地的必要前提。

## 后续待办

- README 的 Status 章节未涉及 owner 维度（待 owner 维度文档稳定后补）
- ext/tenant 的 fixture 已加进 base_schema.ts，但**没有**专门的"多 owner 端到端"
  集成测试（只在 link.test.ts 里有单元用例）。后续可加一个独立 fixture。
- 当前 ext:acme-corp 的 orders 表 FK 引用 `users_base`（未限定 schema），是 projector
  的 v0.2.0 已知局限（FK 渲染原始），与 owner 维度无关。
