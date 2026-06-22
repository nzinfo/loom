import { describe, expect, it } from 'vitest';
import {
  type DiscoveredFile,
  kebabToPascal,
  kindFromFilename,
  pascalToKebab,
  pathToIdentity,
  stemFromFilename,
} from '../src/ir/paths.js';

describe('paths — platform', () => {
  it('derives identity from a platform entity path (flat, ext-encoded)', () => {
    expect(
      pathToIdentity('platform/base/core/user.entity.yaml', 'platform/base/core/user.entity.yaml'),
    ).toEqual<DiscoveredFile>({
      kind: 'entity',
      system: 'base',
      module: 'core',
      name: 'User',
      identity: 'entity:base.core.User',
      owner: { kind: 'platform' },
    });
  });

  it('recognizes a scalar type file (.type.yaml) as a type node', () => {
    expect(
      pathToIdentity(
        'platform/base/core/decimal.type.yaml',
        'platform/base/core/decimal.type.yaml',
      ),
    ).toEqual<DiscoveredFile>({
      kind: 'type',
      system: 'base',
      module: 'core',
      name: 'Decimal',
      identity: 'type:base.core.Decimal',
      owner: { kind: 'platform' },
    });
  });

  it('rejects the former base.types.yaml singleton name (no longer special)', () => {
    // base_types is gone; base.types.yaml is now an unrecognized filename.
    expect(
      pathToIdentity('platform/base/core/base.types.yaml', 'platform/base/core/base.types.yaml'),
    ).toBeNull();
  });

  it('handles kebab-case names under platform', () => {
    expect(
      pathToIdentity(
        'platform/base/core/user-profile.table.yaml',
        'platform/base/core/user-profile.table.yaml',
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

  it('parses extension_fields via .ext.yaml under platform/<sys>/<mod>/', () => {
    expect(
      pathToIdentity(
        'platform/base/core/user_fields.ext.yaml',
        'platform/base/core/user_fields.ext.yaml',
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
  it('derives identity from an ext provider path (flat)', () => {
    expect(
      pathToIdentity(
        'ext/acme-corp/retail/pos/orders.table.yaml',
        'ext/acme-corp/retail/pos/orders.table.yaml',
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

  it('ext can define type (struct) and entity', () => {
    expect(
      pathToIdentity(
        'ext/acme-corp/retail/pos/order-status.type.yaml',
        'ext/acme-corp/retail/pos/order-status.type.yaml',
      )?.kind,
    ).toBe('type');
    expect(
      pathToIdentity(
        'ext/acme-corp/retail/pos/order.entity.yaml',
        'ext/acme-corp/retail/pos/order.entity.yaml',
      )?.kind,
    ).toBe('entity');
  });
});

describe('paths — tenants', () => {
  it('derives extension_fields identity from a tenant .ext.yaml path', () => {
    expect(
      pathToIdentity(
        'tenants/acme/base/core/user_fields.ext.yaml',
        'tenants/acme/base/core/user_fields.ext.yaml',
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

  it('tenant path with a non-ext kind is rejected (tenants only do extension_fields)', () => {
    expect(
      pathToIdentity(
        'tenants/acme/base/core/users.table.yaml',
        'tenants/acme/base/core/users.table.yaml',
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

  it('rejects a bare root filename with no owner prefix', () => {
    expect(pathToIdentity('base.types.yaml', 'base.types.yaml')).toBeNull();
  });

  it('rejects unknown owner prefix', () => {
    expect(
      pathToIdentity('vendor/acme/base/core/x.table.yaml', 'vendor/acme/base/core/x.table.yaml'),
    ).toBeNull();
  });

  it('rejects a file with no recognized kind extension', () => {
    expect(
      pathToIdentity('platform/base/core/unknown/foo.yaml', 'platform/base/core/unknown/foo.yaml'),
    ).toBeNull();
  });

  it('rejects empty path', () => {
    expect(pathToIdentity('', '')).toBeNull();
  });

  it('rejects old kind-directory layout (entity/user.yaml under platform)', () => {
    expect(
      pathToIdentity('platform/base/core/entity/user.yaml', 'platform/base/core/entity/user.yaml'),
    ).toBeNull();
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

describe('paths — kind/stem helpers', () => {
  it('kindFromFilename recognizes each kind token', () => {
    expect(kindFromFilename('user.entity.yaml')).toBe('entity');
    expect(kindFromFilename('orders.table.yaml')).toBe('table');
    expect(kindFromFilename('email.type.yaml')).toBe('type');
    expect(kindFromFilename('audit.mixin.yaml')).toBe('mixin');
    expect(kindFromFilename('user_fields.ext.yaml')).toBe('extension_fields');
    expect(kindFromFilename('base.types.yaml')).toBeNull();
    // module_manifest kind is gone; manifest.module.yaml is now unrecognized
    expect(kindFromFilename('manifest.module.yaml')).toBeNull();
  });

  it('kindFromFilename returns null for unknown extensions', () => {
    expect(kindFromFilename('user.yaml')).toBeNull();
    expect(kindFromFilename('readme.md')).toBeNull();
  });

  it('stemFromFilename strips the kind token, not the name', () => {
    expect(stemFromFilename('user.entity.yaml')).toBe('user');
    expect(stemFromFilename('manifest.module.yaml')).toBeNull();
    expect(stemFromFilename('user_fields.ext.yaml')).toBe('user_fields');
    expect(stemFromFilename('user.yaml')).toBeNull();
  });
});
