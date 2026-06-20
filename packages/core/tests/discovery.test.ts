/**
 * Pass 0 — discovery tests. See spec §13.1 (v2 owner dimension).
 */
import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import type { DiscoveredEntry } from '../src/loader/discovery.js';
import { discover } from '../src/loader/discovery.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

/** Find a discovered entry by identity (files map is path-keyed). */
function findByIdentity(
  files: ReadonlyMap<string, DiscoveredEntry>,
  identity: string,
): DiscoveredEntry | undefined {
  for (const e of files.values()) {
    if (e.identity === identity) return e;
  }
  return undefined;
}

describe('discovery (Pass 0) — platform', () => {
  it('discovers all expected identities', async () => {
    const fs = buildBaseSchemaFs();
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    const ids = new Set([...result.files.values()].map((e) => e.identity));
    expect(diag.hasErrors).toBe(false);
    expect(ids.has('type:base.core.String')).toBe(true);
    expect(ids.has('module_manifest:base.core')).toBe(true);
    expect(ids.has('type:base.core.Email')).toBe(true);
    expect(ids.has('type:base.core.Money')).toBe(true);
    expect(ids.has('mixin:base.core.Audit')).toBe(true);
    expect(ids.has('table:base.core.Users')).toBe(true);
    expect(ids.has('entity:base.core.User')).toBe(true);
    expect(ids.has('extension_fields:base.core.User_fields')).toBe(true);
  });

  it('stamps platform owner on discovered entries', async () => {
    const fs = buildBaseSchemaFs();
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    expect(findByIdentity(result.files, 'table:base.core.Users')?.meta.owner).toEqual({
      kind: 'platform',
    });
  });

  it('reports duplicate identities (case collision on case‑sensitive fs)', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/a.mixin.yaml': '',
      'platform/base/core/A.mixin.yaml': '',
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
      'systems/foo/bar/baz/manifest.module.yaml': '',
      'systems/foo/bar/file.yaml': '',
      // unknown kind extension (plain .yaml with no kind token)
      'platform/base/core/unknown/foo.yaml': '',
      // old kind-directory layout, now flat — no kind token in filename
      'platform/base/core/entity/user.yaml': '',
    });
    const diag = new Diagnostics();
    await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(true);
    expect(
      diag.errors.some((e) => e.message.includes('systems/foo/bar/baz/manifest.module.yaml')),
    ).toBe(true);
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
    expect(findByIdentity(result.files, 'type:base.core.String')).toBeDefined();
    expect(findByIdentity(result.files, 'module_manifest:base.core')).toBeDefined();
    expect(findByIdentity(result.files, 'type:base.core.Email')).toBeDefined();
  });
});

describe('discovery (Pass 0) — ext / tenant owners', () => {
  it('stamps ext owner with provider', async () => {
    const fs = new MemoryFileSystem({
      'ext/acme-corp/retail/pos/manifest.module.yaml':
        'version: loom-schema/v2\nsystem: retail\nmodule: pos\n',
      'ext/acme-corp/retail/pos/orders.table.yaml': 'version: loom-schema/v2\nname: Orders\n',
    });
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(false);
    expect(findByIdentity(result.files, 'table:retail.pos.Orders')?.meta.owner).toEqual({
      kind: 'ext',
      provider: 'acme-corp',
    });
    expect(findByIdentity(result.files, 'module_manifest:retail.pos')?.meta.owner).toEqual({
      kind: 'ext',
      provider: 'acme-corp',
    });
  });

  it('stamps tenant owner with id', async () => {
    const fs = new MemoryFileSystem({
      'tenants/acme/base/core/user_fields.ext.yaml':
        'version: loom-schema/v2\nentity: entity:base.core.User\n',
    });
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(false);
    expect(
      findByIdentity(result.files, 'extension_fields:base.core.User_fields')?.meta.owner,
    ).toEqual({ kind: 'tenant', id: 'acme' });
  });

  it('allows multiple owners to write extension_fields with the same identity', async () => {
    // Both files parse to identity `extension_fields:base.core.User_fields`.
    // Discovery must NOT treat this as a duplicate — they aggregate at link.
    const fs = new MemoryFileSystem({
      'platform/base/core/user_fields.ext.yaml':
        'version: loom-schema/v2\nentity: entity:base.core.User\n',
      'tenants/acme/base/core/user_fields.ext.yaml':
        'version: loom-schema/v2\nentity: entity:base.core.User\n',
    });
    const diag = new Diagnostics();
    const result = await discover({ fs, basePath: '', diagnostics: diag });
    expect(diag.hasErrors).toBe(false);
    const matched = [...result.files.values()].filter(
      (e) => e.identity === 'extension_fields:base.core.User_fields',
    );
    expect(matched.length).toBe(2);
  });
});
