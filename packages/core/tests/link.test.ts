import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import { discover } from '../src/loader/discovery.js';
import { link } from '../src/loader/link.js';
import { parseAll } from '../src/loader/parse.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

async function linkFromStringMap(files: Record<string, string>) {
  const fs = new MemoryFileSystem(files);
  const diag = new Diagnostics();
  const { files: discovered } = await discover({ fs, basePath: '', diagnostics: diag });
  const { parsed, extensionFieldsFiles } = await parseAll({
    fs,
    files: discovered,
    diagnostics: diag,
  });
  return link({ parsed, extensionFieldsFiles, files: discovered, diagnostics: diag });
}

async function runLink(fs: ReturnType<typeof buildBaseSchemaFs>) {
  const diag = new Diagnostics();
  const { files } = await discover({ fs, basePath: '', diagnostics: diag });
  const { parsed, extensionFieldsFiles } = await parseAll({ fs, files, diagnostics: diag });
  return await link({ parsed, extensionFieldsFiles, files, diagnostics: diag });
}

describe('link (Pass 2)', () => {
  it('resolves all refs in the base fixture', async () => {
    const { ir, diagnostics } = await runLink(buildBaseSchemaFs());
    expect(diagnostics.hasErrors).toBe(false);
    const users = ir.nodes.get('table:base.core.Users');
    expect(users).toBeDefined();
    const deps = ir.deps.get('table:base.core.Users');
    expect(deps?.has('value_type:base.core.Email')).toBe(true);
    expect(deps?.has('value_type:base.core.Money')).toBe(true);
    expect(deps?.has('mixin:base.core.Audit')).toBe(true);
  });

  it('reports dangling refs', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/a.mixin.yaml':
        'version: loom-schema/v2\nname: A\nfields:\n  - name: x\n    type: base.core.DoesNotExist\n',
    });
    const { diagnostics } = await runLink(fs);
    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.errors.some((e) => e.category === 'dangling_ref')).toBe(true);
  });

  it('reports kind_mismatch when ref points at wrong kind', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/a.mixin.yaml':
        'version: loom-schema/v2\nname: A\nfields:\n  - name: x\n    type: base.core.Users\n',
      'platform/base/core/users.table.yaml':
        'version: loom-schema/v2\nname: Users\ntable:\n  name: users\n  extension:\n    strategy: none\nfields:\n  - name: id\n    type: string\n    required: true\nprimary_key: [id]\n',
    });
    const { diagnostics } = await runLink(fs);
    expect(diagnostics.errors.some((e) => e.category === 'kind_mismatch')).toBe(true);
  });

  it('reports mixin cycles', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/a.mixin.yaml':
        'version: loom-schema/v2\nname: A\nfields:\n  - include: mixin:base.core.B\n  - name: xa\n    type: string\n',
      'platform/base/core/b.mixin.yaml':
        'version: loom-schema/v2\nname: B\nfields:\n  - include: mixin:base.core.A\n  - name: xb\n    type: string\n',
    });
    const { diagnostics } = await runLink(fs);
    expect(diagnostics.errors.some((e) => e.category === 'cycle')).toBe(true);
  });
});

describe('v2 link — type resolution', () => {
  it('resolves a value_type short name via using wildcard', async () => {
    const { ir, diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: bigint, description: i, properties: [] }
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/email.value_type.yaml': `version: loom-schema/v2
name: Email
fields:
  - { name: value, type: string }
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
using:
  - base.core.*
table:
  name: users_base
  extension: { strategy: none }
fields:
  - { name: id, type: bigint, required: true }
  - { name: email, type: Email, required: true, unique: true }
primary_key: [id]
`,
    });

    expect(diagnostics.hasErrors).toBe(false);
    const usersNode = [...ir.nodes.values()].find((n) => n.kind === 'table');
    expect(usersNode).toBeDefined();
    const fields = (usersNode?.data as { fields: Array<Record<string, unknown>> }).fields;
    // Short name "Email" should be rewritten to its fqn after link.
    const emailField = fields.find((f) => f.name === 'email');
    expect((emailField?.type as { ref: string }).ref).toBe('base.core.Email');
  });

  it('reports ambiguous when using imports two modules with the same type name', async () => {
    const { diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/money.value_type.yaml': `version: loom-schema/v2
name: Money
fields:
  - { name: amount, type: string }
`,
      'platform/retail/types/manifest.module.yaml': `version: loom-schema/v2
system: retail
module: types
physical_schema: retail_types
`,
      'platform/retail/types/money.value_type.yaml': `version: loom-schema/v2
name: Money
fields:
  - name: value
    type: string
`,
      'platform/retail/pos/orders.table.yaml': `version: loom-schema/v2
name: Orders
using:
  - base.core.*
  - retail.types.*
table:
  name: orders
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: total, type: Money }
primary_key: [id]
`,
    });

    expect(diagnostics.hasErrors).toBe(true);
    const ambiguousMsgs = diagnostics.errors.filter((d) => d.message.includes('ambiguous'));
    expect(ambiguousMsgs.length).toBeGreaterThan(0);
  });

  it('reports unknown type when short name matches nothing', async () => {
    const { diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: x, type: Nonexistent }
primary_key: [id]
`,
    });

    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.errors.some((d) => d.message.includes('unknown type'))).toBe(true);
  });

  it('reports kind_mismatch when a three-segment type ref targets a non-value_type', async () => {
    const { diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: x, type: base.core.Users }
primary_key: [id]
`,
    });

    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.errors.some((d) => d.category === 'kind_mismatch')).toBe(true);
  });

  it('rejects a two-segment type ref as invalid form', async () => {
    const { diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: x, type: Foo.Bar }
primary_key: [id]
`,
    });

    expect(diagnostics.hasErrors).toBe(true);
    expect(
      diagnostics.errors.some(
        (d) => d.category === 'parse' && d.message.includes('invalid type reference'),
      ),
    ).toBe(true);
  });
});

describe('v2 link — owner stamping', () => {
  it('stamps platform owner on platform nodes', async () => {
    const { ir } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
primary_key: [id]
`,
    });
    expect(ir.nodes.get('table:base.core.Users')?.owner).toEqual({ kind: 'platform' });
  });

  it('stamps ext owner with provider', async () => {
    const { ir } = await linkFromStringMap({
      'ext/acme-corp/retail/pos/manifest.module.yaml': `version: loom-schema/v2
system: retail
module: pos
physical_schema: acme_retail_pos
`,
      'ext/acme-corp/retail/pos/orders.table.yaml': `version: loom-schema/v2
name: Orders
table:
  name: orders
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
primary_key: [id]
`,
    });
    expect(ir.nodes.get('table:retail.pos.Orders')?.owner).toEqual({
      kind: 'ext',
      provider: 'acme-corp',
    });
  });
});

describe('v2 link — extension_fields aggregation', () => {
  it('excludes extension_fields from nodes map; aggregates into extensionFields', async () => {
    const { ir, diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - { name: id, type: string, required: true }
primary_key: [id]
`,
      'platform/base/core/user.entity.yaml': `version: loom-schema/v2
name: User
primary_table: table:base.core.Users
`,
      'platform/base/core/user_fields.ext.yaml': `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: nickname
    type: string
`,
    });
    expect(diagnostics.hasErrors).toBe(false);
    expect(ir.nodes.has('extension_fields:base.core.User_fields')).toBe(false);
    const bucket = ir.extensionFields.get('entity:base.core.User');
    expect(bucket?.length).toBe(1);
    expect(bucket?.[0]?.name).toBe('nickname');
    expect(bucket?.[0]?.scalar).toBe('string');
  });

  it('aggregates extension_fields across owners (platform + tenant)', async () => {
    const { ir, diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - { name: id, type: string, required: true }
primary_key: [id]
`,
      'platform/base/core/user.entity.yaml': `version: loom-schema/v2
name: User
primary_table: table:base.core.Users
`,
      'platform/base/core/user_fields.ext.yaml': `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: nickname
    type: string
`,
      'tenants/acme/base/core/user_fields.ext.yaml': `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: avatar_url
    type: string
`,
    });
    expect(diagnostics.hasErrors).toBe(false);
    const bucket = ir.extensionFields.get('entity:base.core.User');
    expect(bucket?.map((e) => e.name).sort()).toEqual(['avatar_url', 'nickname']);
  });

  it('rejects same-name extension field across owners', async () => {
    const { diagnostics } = await linkFromStringMap({
      'platform/base/core/base.types.yaml': `version: loom-schema/v2
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/manifest.module.yaml': `version: loom-schema/v2
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/users.table.yaml': `version: loom-schema/v2
name: Users
table:
  name: users
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - { name: id, type: string, required: true }
primary_key: [id]
`,
      'platform/base/core/user.entity.yaml': `version: loom-schema/v2
name: User
primary_table: table:base.core.Users
`,
      'platform/base/core/user_fields.ext.yaml': `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: nickname
    type: string
`,
      'tenants/acme/base/core/user_fields.ext.yaml': `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: nickname
    type: string
`,
    });
    expect(diagnostics.hasErrors).toBe(true);
    expect(
      diagnostics.errors.some((d) => d.message.includes('duplicate extension field "nickname"')),
    ).toBe(true);
  });
});
