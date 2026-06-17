import { describe, expect, it } from 'vitest';
import { load } from '../src/loader/index.js';
import { expandTables } from '../src/projector/expand.js';
import { buildPivotViews } from '../src/projector/views.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';

describe('projector views (spec §7.4)', () => {
  it('produces a pivot view spec for the users table', async () => {
    const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    const model = expandTables(ir);
    const views = buildPivotViews(model, ir);
    const usersView = views.find((v) => v.viewName === 'users');
    expect(usersView).toBeDefined();
    expect(usersView?.baseTable).toBe('base_core.users_base');
    expect(usersView?.extTable).toBe('users_ext');
    expect(usersView?.columns.some((c) => c.fieldName === 'nickname')).toBe(true);
  });

  it('emits no view when strategy != sidecar_eav', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'base_types.yaml':
        'version: loom-schema/v1\nkind: base_types\nscalars:\n  - name: bigint\n    properties: []\n',
      'systems/base/core/MANIFEST.yaml':
        'version: loom-schema/v1\nkind: module_manifest\nsystem: base\nmodule: core\nphysical_schema: base_core\n',
      'systems/base/core/table/t.yaml':
        'version: loom-schema/v1\nkind: table\nname: T\ntable:\n  name: t\n  extension:\n    strategy: none\nfields:\n  - name: id\n    base: bigint\n    required: true\nprimary_key: [id]\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const model = expandTables(ir);
    const views = buildPivotViews(model, ir);
    expect(views).toEqual([]);
  });

  it('expands multi-field value_type refs (e.g. Money) into multiple pivot columns (spec §7.4)', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'base_types.yaml':
        'version: loom-schema/v1\nkind: base_types\nscalars:\n  - name: bigint\n    properties: []\n  - name: decimal\n    properties:\n      - name: precision\n        type: integer\n        required: true\n      - name: scale\n        type: integer\n        required: true\n  - name: string\n    properties:\n      - name: max_length\n        type: integer\n        required: true\n',
      'systems/base/core/MANIFEST.yaml':
        'version: loom-schema/v1\nkind: module_manifest\nsystem: base\nmodule: core\nphysical_schema: base_core\n',
      'systems/base/core/value_type/money.yaml':
        'version: loom-schema/v1\nkind: value_type\nname: Money\nfields:\n  - name: amount\n    base: decimal\n    precision: 18\n    scale: 4\n  - name: currency_code\n    base: string\n    max_length: 3\n',
      'systems/base/core/table/users.yaml':
        'version: loom-schema/v1\nkind: table\nname: Users\ntable:\n  name: users_base\n  extension:\n    strategy: sidecar_eav\n    ext_table: users_ext\n    view: users\nfields:\n  - name: id\n    base: bigint\n    required: true\nprimary_key: [id]\n',
      'systems/base/core/entity/user.yaml':
        'version: loom-schema/v1\nkind: entity\nname: User\nprimary_table: table:base.core.Users\n',
      'systems/base/core/extension/user_fields.yaml':
        'version: loom-schema/v1\nkind: extension_fields\nentity: entity:base.core.User\nfields:\n  - name: credit_limit\n    ref: value_type:base.core.Money\n    default_scope: tenant\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const model = expandTables(ir);
    const views = buildPivotViews(model, ir);
    const usersView = views.find((v) => v.viewName === 'users');
    expect(usersView?.columns.map((c) => c.fieldName)).toEqual(
      expect.arrayContaining(['credit_limit_amount', 'credit_limit_currency_code']),
    );
  });
});
