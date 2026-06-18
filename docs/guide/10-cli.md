# CLI 命令参考

```
loom version                                    打印版本信息（spec §16.2）
loom check <path>                               加载 + 校验（spec §8.7）
loom project sql --dialect <d> [--out <f>] <path>
                                                投影为 SQL DDL
                                                <d>: pg | mysql | sqlite
loom fmt <path>                                 格式化（未实现）
loom lift <physical.yaml>                       反向提炼（未实现）
```

## version

机器可读格式，供下游（atlas 等）协商版本：

```
loom 0.2.0
schema-versions-supported: loom-schema/v2
current: loom-schema/v2
```

## check

加载整个 schema 树并校验，不生成任何产物。所有诊断输出到 stderr。

```sh
loom check my-schema/
echo $?     # 0 通过，1 失败
```

校验管线（4-pass）详见 [11 加载管线](./11-pipeline.md)。

## project sql

```sh
# stdout
loom project sql --dialect pg my-schema/

# 写入文件
loom project sql --dialect mysql --out schema.sql my-schema/
```

方言必须显式指定。`--out` 省略时写 stdout。

> `my-schema/` 是 schema 根目录——直接指向 `platform/`、`ext/`、`tenants/`
> 的父目录（不需要进到 `platform/` 子层）。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 加载 / 校验失败 |
| 2 | 投影失败 |
| 64 | 用法错误 |
