/**
 * Pass 0 — discovery tests. See spec §13.1.
 */
import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import { discover } from '../src/loader/discovery.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

describe('discovery (Pass 0)', () => {
  it('discovers all expected identities', async () => {
    const fs = buildBaseSchemaFs();
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    const ids = new Set(result.files.keys());
    expect(diag.hasErrors).toBe(false);
    expect(ids.has('base_types:')).toBe(true);
    expect(ids.has('module_manifest:base.core')).toBe(true);
    expect(ids.has('value_type:base.core.Email')).toBe(true);
    expect(ids.has('value_type:base.core.Money')).toBe(true);
    expect(ids.has('mixin:base._shared.Audit')).toBe(true);
    expect(ids.has('table:base.core.Users')).toBe(true);
    expect(ids.has('entity:base.core.User')).toBe(true);
    expect(ids.has('extension_fields:base.core.User_fields')).toBe(true);
  });

  it('reports duplicate identities (case collision on case‑sensitive fs)', async () => {
    const fs = new MemoryFileSystem({
      'systems/base/core/mixin/a.yaml': '',
      'systems/base/core/mixin/A.yaml': '',
    });
    const diag = new Diagnostics();
    await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(true);
    expect(diag.errors.length).toBe(1);
    expect(diag.errors[0]?.category).toBe('identity');
    expect(diag.errors[0]?.message).toMatch(/duplicate identity/);
  });

  it('emits identity diagnostic for malformed paths', async () => {
    const fs = new MemoryFileSystem({
      'base_types.yaml': '',
      'systems/foo/bar/baz/MANIFEST.yaml': '',
      'systems/foo/bar/file.yaml': '',
    });
    const diag = new Diagnostics();
    await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(true);
    expect(diag.errors.length).toBe(2);
    expect(diag.errors.some((e) => e.message.includes('foo/bar/baz/MANIFEST.yaml'))).toBe(true);
    expect(diag.errors.some((e) => e.message.includes('foo/bar/file.yaml'))).toBe(true);
  });

  it('filters by system name', async () => {
    const fs = buildBaseSchemaFs();
    const diag = new Diagnostics();
    const result = await discover({
      fs,
      basePath: '',
      systemFilter: ['base'],
      diagnostics: diag,
    });
    expect(diag.hasErrors).toBe(false);
    // root file is always included
    expect(result.files.has('base_types:')).toBe(true);
    expect(result.files.has('module_manifest:base.core')).toBe(true);
    expect(result.files.has('value_type:base.core.Email')).toBe(true);
  });
});
