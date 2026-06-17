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
  const { parsed } = await parseAll({ fs, files: discovered, diagnostics: diag });
  const { ir } = await link({ parsed, diagnostics: diag });
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

describe('v2 projector — expandField via type:', () => {
  it('expands a single-segment type to one column', async () => {
    const model = await expandFromStringMap({
      'base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: bigint, description: i, properties: [] }
  - name: string
    description: s
    properties:
      - { name: max_length, type: integer, required: true }
`,
      'systems/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'systems/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: bigint, required: true }
  - name: email
    type: string
    max_length: 254
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
      'base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: bigint, description: i, properties: [] }
  - name: string
    description: s
    properties:
      - { name: max_length, type: integer, required: true }
`,
      'systems/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'systems/base/core/value_type/email.yaml': `version: loom-schema/v2
kind: value_type
name: Email
fields:
  - name: value
    type: string
    max_length: 254
`,
      'systems/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
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
      'base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: bigint, description: i, properties: [] }
  - name: decimal
    description: d
    properties:
      - { name: precision, type: integer, required: true }
      - { name: scale, type: integer, required: true }
  - name: string
    description: s
    properties:
      - { name: max_length, type: integer, required: true }
`,
      'systems/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'systems/base/core/value_type/money.yaml': `version: loom-schema/v2
kind: value_type
name: Money
fields:
  - name: amount
    type: decimal
    precision: 18
    scale: 4
  - name: currency_code
    type: string
    max_length: 3
`,
      'systems/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
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
});
