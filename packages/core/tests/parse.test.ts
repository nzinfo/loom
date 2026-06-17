import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import { discover } from '../src/loader/discovery.js';
import { parseAll } from '../src/loader/parse.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';

async function baseParsed() {
  const fs = buildBaseSchemaFs();
  const diag = new Diagnostics();
  const { files } = await discover({ fs, basePath: '', diagnostics: diag });
  return parseAll({ fs, files, diagnostics: diag });
}

describe('parse (Pass 1)', () => {
  it('parses all files in the base fixture', async () => {
    const { parsed, diagnostics } = await baseParsed();
    expect(diagnostics.hasErrors).toBe(false);
    expect(parsed.size).toBeGreaterThanOrEqual(8);
  });

  it('emits a version diagnostic on mismatched version', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'base_types.yaml':
        'version: loom-schema/v9\nkind: base_types\nscalars:\n  - name: string\n    properties: []\n',
    });
    const diag = new Diagnostics();
    const { files } = await discover({ fs, basePath: '', diagnostics: diag });
    const { diagnostics: d2 } = await parseAll({ fs, files, diagnostics: diag });
    expect(d2.hasErrors).toBe(true);
    expect(d2.errors.some((e) => e.category === 'version')).toBe(true);
  });

  it('emits a parse diagnostic on schema violation', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'systems/base/core/mixin/a.yaml':
        'version: loom-schema/v2\nkind: mixin\nname: A\nfields:\n  - base: string\n',
    });
    const diag = new Diagnostics();
    const { files } = await discover({ fs, basePath: '', diagnostics: diag });
    const { diagnostics: d2 } = await parseAll({ fs, files, diagnostics: diag });
    expect(d2.hasErrors).toBe(true);
    expect(d2.errors.some((e) => e.category === 'parse')).toBe(true);
  });
});
