/**
 * Pass 0 — discovery tests. See spec §13.1 (v2 owner dimension).
 */
import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import { discover } from '../src/loader/discovery.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

describe('discovery (Pass 0) — platform', () => {
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
    expect(ids.has('mixin:base.core.Audit')).toBe(true);
    expect(ids.has('table:base.core.Users')).toBe(true);
    expect(ids.has('entity:base.core.User')).toBe(true);
    expect(ids.has('extension_fields:base.core.User_fields')).toBe(true);
  });

  it('stamps platform owner on discovered entries', async () => {
    const fs = buildBaseSchemaFs();
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    const node = result.files.get('table:base.core.Users');
    expect(node?.meta.owner).toEqual({ kind: 'platform' });
  });

  it('reports duplicate identities (case collision on case‑sensitive fs)', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/mixin/a.yaml': '',
      'platform/base/core/mixin/A.yaml': '',
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
      // legacy bare base_types.yaml at root — no longer valid in v2
      'base_types.yaml': '',
      // systems/ prefix no longer valid in v2
      'systems/foo/bar/baz/MANIFEST.yaml': '',
      'systems/foo/bar/file.yaml': '',
      // unknown kind dir
      'platform/base/core/unknown/foo.yaml': '',
    });
    const diag = new Diagnostics();
    await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(true);
    expect(diag.errors.some((e) => e.message.includes('systems/foo/bar/baz/MANIFEST.yaml'))).toBe(
      true,
    );
    expect(diag.errors.some((e) => e.message.includes('systems/foo/bar/file.yaml'))).toBe(true);
    expect(diag.errors.some((e) => e.message.includes('platform/base/core/unknown/foo.yaml'))).toBe(
      true,
    );
    expect(diag.errors.some((e) => e.message.includes('base_types.yaml'))).toBe(true);
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
    expect(result.files.has('base_types:')).toBe(true);
    expect(result.files.has('module_manifest:base.core')).toBe(true);
    expect(result.files.has('value_type:base.core.Email')).toBe(true);
  });
});

describe('discovery (Pass 0) — ext / tenant owners', () => {
  it('stamps ext owner with provider', async () => {
    const fs = new MemoryFileSystem({
      'ext/acme-corp/retail/pos/MANIFEST.yaml':
        'version: loom-schema/v2\nkind: module_manifest\nsystem: retail\nmodule: pos\n',
      'ext/acme-corp/retail/pos/table/orders.yaml':
        'version: loom-schema/v2\nkind: table\nname: Orders\n',
    });
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(false);
    expect(result.files.get('table:retail.pos.Orders')?.meta.owner).toEqual({
      kind: 'ext',
      provider: 'acme-corp',
    });
    expect(result.files.get('module_manifest:retail.pos')?.meta.owner).toEqual({
      kind: 'ext',
      provider: 'acme-corp',
    });
  });

  it('stamps tenant owner with id (no kind dir)', async () => {
    const fs = new MemoryFileSystem({
      'tenants/acme/base/core/user_fields.yaml':
        'version: loom-schema/v2\nkind: extension_fields\nentity: entity:base.core.User\n',
    });
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(false);
    expect(result.files.get('extension_fields:base.core.User_fields')?.meta.owner).toEqual({
      kind: 'tenant',
      id: 'acme',
    });
  });
});
