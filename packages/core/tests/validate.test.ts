import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import { discover } from '../src/loader/discovery.js';
import { link } from '../src/loader/link.js';
import { parseAll } from '../src/loader/parse.js';
import { validate } from '../src/loader/validate.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

async function runValidate(fs: ReturnType<typeof buildBaseSchemaFs>) {
  const diag = new Diagnostics();
  const { files } = await discover({ fs, basePath: '', diagnostics: diag });
  const { parsed } = await parseAll({ fs, files, diagnostics: diag });
  const { ir } = await link({ parsed, diagnostics: diag });
  return validate({ ir, diagnostics: diag });
}

describe('validate (Pass 3)', () => {
  it('base fixture passes validation', async () => {
    const { diagnostics } = await runValidate(buildBaseSchemaFs());
    expect(diagnostics.hasErrors).toBe(false);
  });

  it('flags unknown scalar base', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - name: string
    properties: []
`,
      'platform/base/core/mixin/a.yaml': `version: loom-schema/v2
kind: mixin
name: A
fields:
  - name: x
    type: not_a_scalar
`,
    });
    const { diagnostics } = await runValidate(fs);
    expect(
      diagnostics.errors.some((e) => e.category === 'schema' && /unknown scalar/.test(e.message)),
    ).toBe(true);
  });

  it('flags primary_key field that is not required', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - name: bigint
    properties: []
  - name: string
    properties: []
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/table/t.yaml': `version: loom-schema/v2
kind: table
name: T
table:
  name: t
  extension:
    strategy: none
fields:
  - name: id
    type: bigint
primary_key: [id]
`,
    });
    const { diagnostics } = await runValidate(fs);
    expect(
      diagnostics.errors.some((e) => e.category === 'semantic' && /primary_key/.test(e.message)),
    ).toBe(true);
  });

  it('flags extension_fields targeting a non-sidecar entity', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - name: bigint
    properties: []
  - name: string
    properties: []
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/table/t.yaml': `version: loom-schema/v2
kind: table
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
      'platform/base/core/entity/t.yaml': `version: loom-schema/v2
kind: entity
name: T
primary_table: table:base.core.T
`,
      'platform/base/core/extension/t_fields.yaml': `version: loom-schema/v2
kind: extension_fields
entity: entity:base.core.T
fields:
  - name: note
    type:
      ref: string
      args: { max_length: 10 }
`,
    });
    const { diagnostics } = await runValidate(fs);
    expect(
      diagnostics.errors.some((e) => e.category === 'semantic' && /sidecar_eav/.test(e.message)),
    ).toBe(true);
  });

  it('validates scalar property presence (decimal requires precision/scale)', async () => {
    const fs = new MemoryFileSystem({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - name: decimal
    properties:
      - name: precision
        type: integer
        required: true
      - name: scale
        type: integer
        required: true
`,
      'platform/base/core/mixin/a.yaml': `version: loom-schema/v2
kind: mixin
name: A
fields:
  - name: x
    type: decimal
`,
    });
    const { diagnostics } = await runValidate(fs);
    expect(
      diagnostics.errors.some((e) => e.category === 'schema' && /precision/.test(e.message)),
    ).toBe(true);
  });
});

async function validateFromStringMap(files: Record<string, string>) {
  const fs = new MemoryFileSystem(files);
  const diag = new Diagnostics();
  const { files: discovered } = await discover({ fs, basePath: '', diagnostics: diag });
  const { parsed } = await parseAll({ fs, files: discovered, diagnostics: diag });
  const { ir } = await link({ parsed, diagnostics: diag });
  validate({ ir, diagnostics: diag });
  return diag;
}

describe('v2 validate — typed fields', () => {
  it('reports unknown scalar for a single-segment type not in base_types', async () => {
    const diag = await validateFromStringMap({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: age, type: notAScalar }
primary_key: [id]
`,
    });

    expect(diag.hasErrors).toBe(true);
    expect(
      diag.errors.some(
        (d) => d.message.includes('unknown scalar') && d.message.includes('notAScalar'),
      ),
    ).toBe(true);
  });

  it('reports missing required scalar property (decimal needs precision/scale)', async () => {
    const diag = await validateFromStringMap({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - name: decimal
    description: d
    properties:
      - { name: precision, type: integer, required: true }
      - { name: scale, type: integer, required: true }
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/value_type/money.yaml': `version: loom-schema/v2
kind: value_type
name: Money
fields:
  - name: amount
    type:
      ref: decimal
      args: { precision: 18 }
`,
      'platform/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
using:
  - base.core.*
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: balance, type: Money }
primary_key: [id]
`,
    });

    expect(diag.hasErrors).toBe(true);
    expect(diag.errors.some((d) => d.message.includes('scale'))).toBe(true);
  });

  it('passes when a three-segment value_type ref is used (no scalar check on the ref)', async () => {
    const diag = await validateFromStringMap({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/value_type/email.yaml': `version: loom-schema/v2
kind: value_type
name: Email
fields:
  - { name: value, type: string }
`,
      'platform/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
using:
  - base.core.*
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: email, type: base.core.Email }
primary_key: [id]
`,
    });

    expect(diag.hasErrors).toBe(false);
  });

  it('still checks primary_key fields are required:true', async () => {
    const diag = await validateFromStringMap({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string }
primary_key: [id]
`,
    });

    expect(diag.hasErrors).toBe(true);
    expect(
      diag.errors.some((d) => d.message.includes('primary_key') && d.message.includes('required')),
    ).toBe(true);
  });

  it('rejects a bare "enum" type ref in a table (enum scalar was removed; use variants in a value_type)', async () => {
    const diag = await validateFromStringMap({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - name: status
    type: enum
primary_key: [id]
`,
    });

    expect(diag.hasErrors).toBe(true);
    expect(diag.errors.some((d) => d.message.includes('unknown scalar type "enum"'))).toBe(true);
  });

  it('allows variants in a value_type file (sum type form)', async () => {
    const diag = await validateFromStringMap({
      'platform/base/core/base_types.yaml': `version: loom-schema/v2
kind: base_types
scalars:
  - { name: string, description: s, properties: [] }
`,
      'platform/base/core/MANIFEST.yaml': `version: loom-schema/v2
kind: module_manifest
system: base
module: core
physical_schema: base_core
`,
      'platform/base/core/value_type/status.yaml': `version: loom-schema/v2
kind: value_type
name: Status
variants: [active, inactive]
`,
      'platform/base/core/table/users.yaml': `version: loom-schema/v2
kind: table
name: Users
using:
  - base.core.*
table:
  name: users
  extension: { strategy: none }
fields:
  - { name: id, type: string, required: true }
  - { name: status, type: Status }
primary_key: [id]
`,
    });

    expect(diag.hasErrors).toBe(false);
  });
});
