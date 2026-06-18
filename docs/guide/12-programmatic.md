# 编程式调用

`@loom/core` 完全环境无关——不依赖 `node:fs`，文件系统通过依赖注入。

## 最小调用

```typescript
import { load, projectSqlFromIr } from '@loom/core';
import { NodeFileSystem } from './my-fs-adapter';

const { ir, diagnostics } = await load({
  fs: new NodeFileSystem(),
  basePath: '/path/to/my-schema',
});

if (diagnostics.hasErrors) {
  for (const d of diagnostics.all) console.error(d.message);
  process.exit(1);
}

const sql = projectSqlFromIr(ir, 'pg');     // 'pg' | 'mysql' | 'sqlite'
console.log(sql);
```

## FileSystem 接口

core 包不直接读文件。你需要实现 `FileSystem`：

```typescript
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  listFiles(dir: string): AsyncIterable<string>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
}
```

这样 core 可以在浏览器（用 fetch / in-memory map）、Deno、worker 中跑——
测试用的 `MemoryFileSystem` 就是基于一个 `Map<string, string>` 实现的。

## 取物理模型（不走 SQL）

```typescript
import { load, expandTables } from '@loom/core';

const { ir } = await load({ fs, basePath });
const model = expandTables(ir);

for (const t of model.tables) {
  console.log(t.qualifiedName, t.columns.map(c => c.name));
  console.log('  enums:', [...model.enums.keys()]);
}
```

`PhysicalModel` 的形状见 `packages/core/src/projector/types.ts`。

## 部分加载

```typescript
await load({ fs, basePath, systemFilter: ['base'] });   // 只加载 base 系统
```

适合增量场景或部分投影。
