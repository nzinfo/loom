import { describe, expect, it } from 'vitest';
import { load } from '../src/loader/index.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

describe('load (end-to-end)', () => {
  it('loads the base fixture with no errors', async () => {
    const result = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    expect(result.diagnostics.hasErrors).toBe(false);
    expect(result.ir.nodes.size).toBeGreaterThanOrEqual(8);
    expect(result.ir.version).toBe('loom-schema/v2');
  });

  it('surfaces discovery errors via diagnostics', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/garbage/x.yaml':
        'version: loom-schema/v2\nname: X\nform: struct\nfields:\n  - name: a\n    type: string\n',
    });
    const result = await load({ fs, basePath: '' });
    expect(result.diagnostics.hasErrors).toBe(true);
  });

  it('respects systemFilter', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/string.type.yaml':
        'version: loom-schema/v2\nname: string\nform: scalar\nproperties: []\n',
      'platform/base/core/a.type.yaml':
        'version: loom-schema/v2\nname: A\nform: struct\nfields:\n  - name: x\n    type: string\n',
      'platform/retail/core/b.type.yaml':
        'version: loom-schema/v2\nname: B\nform: struct\nfields:\n  - name: y\n    type: string\n',
    });
    const result = await load({ fs, basePath: '', systemFilter: ['base'] });
    expect(result.diagnostics.hasErrors).toBe(false);
    expect([...result.ir.nodes.keys()]).toEqual(['type:base.core.string', 'type:base.core.A']);
  });
});
