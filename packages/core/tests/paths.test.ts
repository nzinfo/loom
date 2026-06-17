import { describe, expect, it } from 'vitest';
import {
  type DiscoveredFile,
  kebabToPascal,
  pascalToKebab,
  pathToIdentity,
} from '../src/ir/paths.js';

describe('paths', () => {
  it('derives identity from a well-formed entity path', () => {
    expect(
      pathToIdentity('systems/base/core/entity/user.yaml', 'base/core/entity/user.yaml'),
    ).toEqual<DiscoveredFile>({
      kind: 'entity',
      system: 'base',
      module: 'core',
      name: 'User',
      identity: 'entity:base.core.User',
    });
  });

  it('handles kebab-case names', () => {
    expect(
      pathToIdentity(
        'systems/base/core/table/user-profile.yaml',
        'base/core/table/user-profile.yaml',
      ),
    ).toEqual<DiscoveredFile>({
      kind: 'table',
      system: 'base',
      module: 'core',
      name: 'UserProfile',
      identity: 'table:base.core.UserProfile',
    });
  });

  it('recognizes MANIFEST.yaml as module_manifest', () => {
    expect(
      pathToIdentity('systems/base/core/MANIFEST.yaml', 'base/core/MANIFEST.yaml'),
    ).toEqual<DiscoveredFile>({
      kind: 'module_manifest',
      system: 'base',
      module: 'core',
      name: '',
      identity: 'module_manifest:base.core',
    });
  });

  it('recognizes root base_types.yaml', () => {
    expect(pathToIdentity('base_types.yaml', 'base_types.yaml')).toEqual<DiscoveredFile>({
      kind: 'base_types',
      system: '',
      module: '',
      name: '',
      identity: 'base_types:',
    });
  });

  it('returns null for unrecognized paths', () => {
    expect(
      pathToIdentity('systems/base/core/unknown/foo.yaml', 'base/core/unknown/foo.yaml'),
    ).toBeNull();
  });

  it('converts kebab ↔ pascal', () => {
    expect(kebabToPascal('user-profile')).toBe('UserProfile');
    expect(pascalToKebab('UserProfile')).toBe('user-profile');
  });
});
