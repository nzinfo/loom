import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, FILE_KIND, FORMAT_FAMILY, FORMAT_VERSION } from '../src/index.js';
import type { Owner } from '../src/ir/version.js';

describe('format version', () => {
  it('exposes the expected family and version', () => {
    expect(FORMAT_FAMILY).toBe('loom-schema');
    expect(FORMAT_VERSION).toBe('v2');
    expect(CURRENT_VERSION).toBe('loom-schema/v2');
  });

  it('covers every file kind from spec §9', () => {
    expect(FILE_KIND).toEqual([
      'type',
      'mixin',
      'table',
      'entity',
      'extension_fields',
      'module_manifest',
    ]);
  });
});

describe('Owner type', () => {
  it('discriminates three owner kinds', () => {
    const owners: Owner[] = [
      { kind: 'platform' },
      { kind: 'ext', provider: 'acme-corp' },
      { kind: 'tenant', id: 'acme' },
    ];
    const kinds = owners.map((o) => o.kind);
    expect(new Set(kinds).size).toBe(3);
    expect(kinds).toEqual(['platform', 'ext', 'tenant']);
  });

  it('ext owner carries provider; tenant owner carries id', () => {
    const ext: Owner = { kind: 'ext', provider: 'sap' };
    const tenant: Owner = { kind: 'tenant', id: 'globex' };
    expect(ext.kind === 'ext' && ext.provider).toBe('sap');
    expect(tenant.kind === 'tenant' && tenant.id).toBe('globex');
  });
});
