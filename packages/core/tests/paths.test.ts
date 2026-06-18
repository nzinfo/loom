import { describe, expect, it } from 'vitest';
import {
  type DiscoveredFile,
  kebabToPascal,
  pascalToKebab,
  pathToIdentity,
} from '../src/ir/paths.js';

describe('paths — platform', () => {
  it('derives identity from a platform entity path', () => {
    expect(
      pathToIdentity('platform/base/core/entity/user.yaml', 'platform/base/core/entity/user.yaml'),
    ).toEqual<DiscoveredFile>({
      kind: 'entity',
      system: 'base',
      module: 'core',
      name: 'User',
      identity: 'entity:base.core.User',
      owner: { kind: 'platform' },
    });
  });

  it('recognizes platform MANIFEST.yaml', () => {
    expect(
      pathToIdentity('platform/base/core/MANIFEST.yaml', 'platform/base/core/MANIFEST.yaml'),
    ).toEqual<DiscoveredFile>({
      kind: 'module_manifest',
      system: 'base',
      module: 'core',
      name: '',
      identity: 'module_manifest:base.core',
      owner: { kind: 'platform' },
    });
  });

  it('recognizes base_types.yaml only at platform/base/core/', () => {
    expect(
      pathToIdentity('platform/base/core/base_types.yaml', 'platform/base/core/base_types.yaml'),
    ).toEqual<DiscoveredFile>({
      kind: 'base_types',
      system: 'base',
      module: 'core',
      name: '',
      identity: 'base_types:',
      owner: { kind: 'platform' },
    });
  });

  it('rejects base_types.yaml at any other platform path', () => {
    expect(
      pathToIdentity('platform/hr/core/base_types.yaml', 'platform/hr/core/base_types.yaml'),
    ).toBeNull();
  });

  it('rejects base_types.yaml under ext or tenants', () => {
    expect(
      pathToIdentity('ext/acme/base/core/base_types.yaml', 'ext/acme/base/core/base_types.yaml'),
    ).toBeNull();
    expect(
      pathToIdentity('tenants/acme/base_types.yaml', 'tenants/acme/base_types.yaml'),
    ).toBeNull();
  });

  it('handles kebab-case names under platform', () => {
    expect(
      pathToIdentity(
        'platform/base/core/table/user-profile.yaml',
        'platform/base/core/table/user-profile.yaml',
      ),
    ).toEqual<DiscoveredFile>({
      kind: 'table',
      system: 'base',
      module: 'core',
      name: 'UserProfile',
      identity: 'table:base.core.UserProfile',
      owner: { kind: 'platform' },
    });
  });

  it('parses extension_fields under platform/<sys>/<mod>/extension/', () => {
    expect(
      pathToIdentity(
        'platform/base/core/extension/user_fields.yaml',
        'platform/base/core/extension/user_fields.yaml',
      ),
    ).toEqual<DiscoveredFile>({
      kind: 'extension_fields',
      system: 'base',
      module: 'core',
      name: 'User_fields',
      identity: 'extension_fields:base.core.User_fields',
      owner: { kind: 'platform' },
    });
  });
});

describe('paths — ext', () => {
  it('derives identity from an ext provider path', () => {
    expect(
      pathToIdentity(
        'ext/acme-corp/retail/pos/table/orders.yaml',
        'ext/acme-corp/retail/pos/table/orders.yaml',
      ),
    ).toEqual<DiscoveredFile>({
      kind: 'table',
      system: 'retail',
      module: 'pos',
      name: 'Orders',
      identity: 'table:retail.pos.Orders',
      owner: { kind: 'ext', provider: 'acme-corp' },
    });
  });

  it('recognizes ext MANIFEST.yaml', () => {
    expect(
      pathToIdentity(
        'ext/acme-corp/retail/pos/MANIFEST.yaml',
        'ext/acme-corp/retail/pos/MANIFEST.yaml',
      ),
    ).toEqual<DiscoveredFile>({
      kind: 'module_manifest',
      system: 'retail',
      module: 'pos',
      name: '',
      identity: 'module_manifest:retail.pos',
      owner: { kind: 'ext', provider: 'acme-corp' },
    });
  });

  it('ext can define value_type and entity', () => {
    expect(
      pathToIdentity(
        'ext/acme-corp/retail/pos/value_type/order-status.yaml',
        'ext/acme-corp/retail/pos/value_type/order-status.yaml',
      )?.kind,
    ).toBe('value_type');
    expect(
      pathToIdentity(
        'ext/acme-corp/retail/pos/entity/order.yaml',
        'ext/acme-corp/retail/pos/entity/order.yaml',
      )?.kind,
    ).toBe('entity');
  });
});

describe('paths — tenants', () => {
  it('derives extension_fields identity from a tenant path (no kind dir)', () => {
    expect(
      pathToIdentity(
        'tenants/acme/base/core/user_fields.yaml',
        'tenants/acme/base/core/user_fields.yaml',
      ),
    ).toEqual<DiscoveredFile>({
      kind: 'extension_fields',
      system: 'base',
      module: 'core',
      name: 'User_fields',
      identity: 'extension_fields:base.core.User_fields',
      owner: { kind: 'tenant', id: 'acme' },
    });
  });

  it('tenant with 4-segment inner path (kind dir) is rejected', () => {
    expect(
      pathToIdentity(
        'tenants/acme/base/core/table/users.yaml',
        'tenants/acme/base/core/table/users.yaml',
      ),
    ).toBeNull();
  });
});

describe('paths — legacy / invalid', () => {
  it('rejects the legacy systems/ prefix', () => {
    expect(
      pathToIdentity('systems/base/core/entity/user.yaml', 'systems/base/core/entity/user.yaml'),
    ).toBeNull();
  });

  it('rejects a bare root base_types.yaml (must be under platform/base/core/)', () => {
    expect(pathToIdentity('base_types.yaml', 'base_types.yaml')).toBeNull();
  });

  it('rejects unknown owner prefix', () => {
    expect(
      pathToIdentity('vendor/acme/base/core/table/x.yaml', 'vendor/acme/base/core/table/x.yaml'),
    ).toBeNull();
  });

  it('rejects unrecognized kind dir', () => {
    expect(
      pathToIdentity('platform/base/core/unknown/foo.yaml', 'platform/base/core/unknown/foo.yaml'),
    ).toBeNull();
  });

  it('rejects empty path', () => {
    expect(pathToIdentity('', '')).toBeNull();
  });
});

describe('paths — kebab ↔ pascal', () => {
  it('converts kebab ↔ pascal', () => {
    expect(kebabToPascal('user-profile')).toBe('UserProfile');
    expect(pascalToKebab('UserProfile')).toBe('user-profile');
  });

  it('joins multi-word kebab → pascal correctly', () => {
    expect(kebabToPascal('user-profile-settings')).toBe('UserProfileSettings');
  });

  it('handles empty kebab segments gracefully', () => {
    expect(kebabToPascal('--double')).toBe('Double');
    expect(kebabToPascal('')).toBe('');
  });
});
