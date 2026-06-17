import { describe, expect, it } from 'vitest';
import { load } from '../src/loader/index.js';
import { expandTables } from '../src/projector/expand.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';

describe('projector expand', () => {
  it('expands the users table to a physical table with strategy sidecar_eav', async () => {
    const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    const phys = expandTables(ir);
    const users = phys.tables.find((t) => t.name === 'users_base');
    expect(users).toBeDefined();
    expect(users?.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'id',
        'created_at',
        'updated_at',
        'email',
        'balance_amount',
        'balance_currency_code',
      ]),
    );
  });

  it('records the view name and ext table for sidecar_eav tables', async () => {
    const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    const phys = expandTables(ir);
    const users = phys.tables.find((t) => t.name === 'users_base');
    expect(users?.viewName).toBe('users');
    expect(users?.extTableName).toBe('users_ext');
  });

  it('prefixes table names with physical_schema from module_manifest (spec §6.2)', async () => {
    const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    const phys = expandTables(ir);
    const users = phys.tables.find((t) => t.name === 'users_base');
    expect(users?.schema).toBe('base_core');
    expect(users?.qualifiedName).toBe('base_core.users_base');
  });

  it('produces no ext columns for strategy=none', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'base_types.yaml': `version: loom-schema/v1
kind: base_types
scalars:
  - name: bigint
    properties: []
`,
      'systems/base/core/MANIFEST.yaml': `version: loom-schema/v1
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'systems/base/core/table/t.yaml': `version: loom-schema/v1
kind: table
name: T
table:
  name: t
  extension:
    strategy: none
fields:
  - name: id
    base: bigint
    required: true
primary_key: [id]
`,
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const t = phys.tables[0];
    expect(t.extTableName).toBeUndefined();
    expect(t.viewName).toBeUndefined();
  });

  it('exposes enum registry keyed by value_type identity (spec §11)', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'base_types.yaml': `version: loom-schema/v1
kind: base_types
scalars:
  - name: enum
    properties:
      - name: values
        type: array<string>
        required: true
`,
      'systems/base/core/MANIFEST.yaml': `version: loom-schema/v1
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'systems/base/core/value_type/status.yaml': `version: loom-schema/v1
kind: value_type
name: Status
fields:
  - name: value
    base: enum
    values: [active, inactive]
`,
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    expect(phys.enums.get('value_type:base.core.Status')).toEqual(['active', 'inactive']);
  });

  it('exposes extension_fields registry keyed by entity identity (spec §7.5)', async () => {
    const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    const phys = expandTables(ir);
    const ext = phys.extensionFields.get('entity:base.core.User');
    expect(ext).toBeDefined();
    expect(ext?.[0]?.name).toBe('nickname');
  });
});
