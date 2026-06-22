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
      'platform/base/core/bigint.type.yaml':
        'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
      'platform/base/core/t.table.yaml':
        'version: loom-schema/v2\nname: T\ntable:\n  name: t\n  extension:\n    strategy: none\nfields:\n  - name: id\n    type: bigint\n    required: true\nprimary_key: [id]\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const model = expandTables(ir);
    const views = buildPivotViews(model, ir);
    expect(views).toEqual([]);
  });

  it('expands multi-field value_type refs (e.g. Money) into multiple pivot columns (spec §7.4)', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'platform/base/core/bigint.type.yaml':
        'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
      'platform/base/core/decimal.type.yaml':
        'version: loom-schema/v2\nname: decimal\nform: scalar\nproperties:\n  - { name: precision, type: integer, required: true }\n  - { name: scale, type: integer, required: true }\n',
      'platform/base/core/string.type.yaml':
        'version: loom-schema/v2\nname: string\nform: scalar\nproperties:\n  - { name: max_length, type: integer, required: true }\n',
      'platform/base/core/money.type.yaml':
        'version: loom-schema/v2\nname: Money\nform: struct\nfields:\n  - name: amount\n    type:\n      ref: decimal\n      args: { precision: 18, scale: 4 }\n  - name: currency_code\n    type:\n      ref: string\n      args: { max_length: 3 }\n',
      'platform/base/core/users.table.yaml':
        'version: loom-schema/v2\nname: Users\ntable:\n  name: users_base\n  extension:\n    strategy: sidecar_eav\n    ext_table: users_ext\nfields:\n  - name: id\n    type: bigint\n    required: true\nprimary_key: [id]\n',
      'platform/base/core/user.entity.yaml':
        'version: loom-schema/v2\nname: User\nprimary_table: table:base.core.Users\nview: users\n',
      'platform/base/core/user_fields.ext.yaml':
        'version: loom-schema/v2\nentity: entity:base.core.User\nfields:\n  - name: credit_limit\n    type: base.core.Money\n    default_scope: tenant\n',
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
