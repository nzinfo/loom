import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import { discover } from '../src/loader/discovery.js';
import { load } from '../src/loader/index.js';
import { link } from '../src/loader/link.js';
import { parseAll } from '../src/loader/parse.js';
import { expandTables } from '../src/projector/expand.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

async function expandFromStringMap(files: Record<string, string>) {
  const fs = new MemoryFileSystem(files);
  const diag = new Diagnostics();
  const { files: discovered } = await discover({ fs, basePath: '', diagnostics: diag });
  const { parsed, extensionFieldsFiles } = await parseAll({
    fs,
    files: discovered,
    diagnostics: diag,
  });
  const { ir } = await link({
    parsed,
    extensionFieldsFiles,
    files: discovered,
    diagnostics: diag,
  });
  return expandTables(ir);
}

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
      'platform/base/core/bigint.type.yaml': `version: loom-schema/v2
name: bigint
form: scalar
properties: []
`,
      'platform/base/core/t.table.yaml': `version: loom-schema/v2
name: T
table:
  name: t
  extension:
    strategy: none
fields:
  - name: id
    type: bigint
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
      'platform/base/core/bigint.type.yaml': `version: loom-schema/v2
name: bigint
form: scalar
properties: []
`,
      'platform/base/core/status.type.yaml': `version: loom-schema/v2
name: Status
form: enum
variants: [active, inactive]
`,
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    expect(phys.enums.get('type:base.core.Status')).toEqual(['active', 'inactive']);
  });

  it('exposes extension_fields registry keyed by entity identity (spec §7.5)', async () => {
    const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    const phys = expandTables(ir);
    const ext = phys.extensionFields.get('entity:base.core.User');
    expect(ext).toBeDefined();
    expect(ext?.[0]?.name).toBe('nickname');
  });
});

describe('v2 projector — expandField via type:', () => {
  it('expands a single-segment type to one column', async () => {
    const model = await expandFromStringMap({
      'platform/base/core/bigint.type.yaml': `version: loom-schema/v2
name: bigint
form: scalar
properties: []
`,
      'platform/base/core/string.type.yaml': `version: loom-schema/v2
name: string
form: scalar
properties:
  - { name: max_length, type: integer, required: true }
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: bigint, required: true }
  - name: email
    type:
      ref: string
      args: { max_length: 254 }
primary_key: [id]
`,
    });

    const users = model.tables.find((t) => t.name === 'users');
    expect(users).toBeDefined();
    const cols = users?.columns.map((c) => `${c.name}:${c.scalar}`) ?? [];
    expect(cols).toContain('email:string');
  });

  it('expands a three-segment single-field value_type ref to one column (no suffix)', async () => {
    const model = await expandFromStringMap({
      'platform/base/core/bigint.type.yaml': `version: loom-schema/v2
name: bigint
form: scalar
properties: []
`,
      'platform/base/core/email.type.yaml': `version: loom-schema/v2
name: Email
form: struct
fields:
  - name: value
    type:
      ref: string
      args: { max_length: 254 }
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
using:
  - base.core.*
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: bigint, required: true }
  - { name: email, type: Email, required: true }
primary_key: [id]
`,
    });

    const users = model.tables.find((t) => t.name === 'users');
    const cols = users?.columns.map((c) => `${c.name}:${c.scalar}`) ?? [];
    expect(cols).toContain('email:string');
  });

  it('expands a multi-field value_type ref to N prefixed columns', async () => {
    const model = await expandFromStringMap({
      'platform/base/core/bigint.type.yaml': `version: loom-schema/v2
name: bigint
form: scalar
properties: []
`,
      'platform/base/core/money.type.yaml': `version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type:
      ref: decimal
      args: { precision: 18, scale: 4 }
  - name: currency_code
    type:
      ref: string
      args: { max_length: 3 }
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
using:
  - base.core.*
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: bigint, required: true }
  - { name: balance, type: Money }
primary_key: [id]
`,
    });

    const users = model.tables.find((t) => t.name === 'users');
    const colNames = users?.columns.map((c) => c.name).sort() ?? [];
    expect(colNames).toEqual(['balance_amount', 'balance_currency_code', 'id']);
  });

  it('records enumRef as the full value_type identity for an enum value_type', async () => {
    const model = await expandFromStringMap({
      'platform/base/core/bigint.type.yaml': `version: loom-schema/v2
name: bigint
form: scalar
properties: []
`,
      'platform/base/core/status.type.yaml': `version: loom-schema/v2
name: Status
form: enum
variants: [active, inactive]
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
using:
  - base.core.*
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: bigint, required: true }
  - { name: status, type: Status }
primary_key: [id]
`,
    });

    const users = model.tables.find((t) => t.name === 'users');
    const statusCol = users?.columns.find((c) => c.name === 'status');
    expect(statusCol).toBeDefined();
    // enumRef must be the full identity, not the bare fqn — the enum
    // registry is keyed by identity and dialect generators look it up.
    expect(statusCol?.enumRef).toBe('type:base.core.Status');
    expect(model.enums.get('type:base.core.Status')).toEqual(['active', 'inactive']);
  });
});
