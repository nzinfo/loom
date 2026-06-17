import { describe, expect, it } from 'vitest';
import { discover } from '../src/loader/discovery.js';
import { parseAll } from '../src/loader/parse.js';
import { link } from '../src/loader/link.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';
import { Diagnostics } from '../src/errors.js';

async function runLink(fs: ReturnType<typeof buildBaseSchemaFs>) {
  const diag = new Diagnostics();
  const { files } = await discover({ fs, basePath: '', diagnostics: diag });
  const { parsed } = await parseAll({ fs, files, diagnostics: diag });
  return await link({ parsed, diagnostics: diag });
}

describe('link (Pass 2)', () => {
  it('resolves all refs in the base fixture', async () => {
    const { ir, diagnostics } = await runLink(buildBaseSchemaFs());
    expect(diagnostics.hasErrors).toBe(false);
    const users = ir.nodes.get('table:base.core.Users');
    expect(users).toBeDefined();
    const deps = ir.deps.get('table:base.core.Users');
    expect(deps?.has('value_type:base.core.Email')).toBe(true);
    expect(deps?.has('value_type:base.core.Money')).toBe(true);
    expect(deps?.has('mixin:base._shared.Audit')).toBe(true);
  });

  it('reports dangling refs', async () => {
    const fs = new MemoryFileSystem({
      'systems/base/core/mixin/a.yaml': `version: loom-schema/v1\nkind: mixin\nname: A\nfields:\n  - name: x\n    ref: value_type:base.core.DoesNotExist\n`,
    });
    const { diagnostics } = await runLink(fs);
    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.errors.some((e) => e.category === 'dangling_ref')).toBe(true);
  });

  it('reports kind_mismatch when ref points at wrong kind', async () => {
    const fs = new MemoryFileSystem({
      'systems/base/core/mixin/a.yaml': `version: loom-schema/v1\nkind: mixin\nname: A\nfields:\n  - name: x\n    ref: entity:base.core.Whatever\n`,
    });
    const { diagnostics } = await runLink(fs);
    expect(diagnostics.errors.some((e) => e.category === 'kind_mismatch')).toBe(true);
  });

  it('reports mixin cycles', async () => {
    const fs = new MemoryFileSystem({
      'systems/base/core/mixin/a.yaml': `version: loom-schema/v1\nkind: mixin\nname: A\nfields:\n  - include: mixin:base.core.B\n  - name: xa\n    base: string\n`,
      'systems/base/core/mixin/b.yaml': `version: loom-schema/v1\nkind: mixin\nname: B\nfields:\n  - include: mixin:base.core.A\n  - name: xb\n    base: string\n`,
    });
    const { diagnostics } = await runLink(fs);
    expect(diagnostics.errors.some((e) => e.category === 'cycle')).toBe(true);
  });
});
