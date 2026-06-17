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
      'base_types.yaml': `version: loom-schema/v1
kind: base_types
scalars:
  - name: string
    properties: []
`,
      'systems/base/core/mixin/a.yaml': `version: loom-schema/v1
kind: mixin
name: A
fields:
  - name: x
    base: not_a_scalar
`,
    });
    const { diagnostics } = await runValidate(fs);
    expect(
      diagnostics.errors.some((e) => e.category === 'schema' && /unknown scalar/.test(e.message)),
    ).toBe(true);
  });

  it('flags primary_key field that is not required', async () => {
    const fs = new MemoryFileSystem({
      'base_types.yaml': `version: loom-schema/v1
kind: base_types
scalars:
  - name: bigint
    properties: []
  - name: string
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
      'base_types.yaml': `version: loom-schema/v1
kind: base_types
scalars:
  - name: bigint
    properties: []
  - name: string
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
      'systems/base/core/entity/t.yaml': `version: loom-schema/v1
kind: entity
name: T
primary_table: table:base.core.T
`,
      'systems/base/core/extension/t_fields.yaml': `version: loom-schema/v1
kind: extension_fields
entity: entity:base.core.T
fields:
  - name: note
    base: string
    max_length: 10
`,
    });
    const { diagnostics } = await runValidate(fs);
    expect(
      diagnostics.errors.some((e) => e.category === 'semantic' && /sidecar_eav/.test(e.message)),
    ).toBe(true);
  });

  it('validates scalar property presence (decimal requires precision/scale)', async () => {
    const fs = new MemoryFileSystem({
      'base_types.yaml': `version: loom-schema/v1
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
      'systems/base/core/mixin/a.yaml': `version: loom-schema/v1
kind: mixin
name: A
fields:
  - name: x
    base: decimal
`,
    });
    const { diagnostics } = await runValidate(fs);
    expect(
      diagnostics.errors.some((e) => e.category === 'schema' && /precision/.test(e.message)),
    ).toBe(true);
  });
});
