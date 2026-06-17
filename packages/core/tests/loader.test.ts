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
      'systems/base/core/garbage/x.yaml':
        'version: loom-schema/v2\nkind: mixin\nname: X\nfields:\n  - name: a\n    type: string\n',
    });
    const result = await load({ fs, basePath: '' });
    expect(result.diagnostics.hasErrors).toBe(true);
  });

  it('respects systemFilter', async () => {
    const fs = new MemoryFileSystem({
      'base_types.yaml':
        'version: loom-schema/v2\nkind: base_types\nscalars:\n  - name: string\n    properties: []\n',
      'systems/base/core/mixin/a.yaml':
        'version: loom-schema/v2\nkind: mixin\nname: A\nfields:\n  - name: x\n    type: string\n',
      'systems/retail/core/mixin/b.yaml':
        'version: loom-schema/v2\nkind: mixin\nname: B\nfields:\n  - name: y\n    type: string\n',
    });
    const result = await load({ fs, basePath: '', systemFilter: ['base'] });
    expect(result.diagnostics.hasErrors).toBe(false);
    expect([...result.ir.nodes.keys()]).toEqual(['base_types:', 'mixin:base.core.A']);
  });
});
