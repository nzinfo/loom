import { describe, expect, it } from 'vitest';
import {
  type AnyFile,
  EntitySchema,
  ExtensionFieldsSchema,
  MixinSchema,
  ModuleManifestSchema,
  ParseError,
  TableSchema,
  TypeSchema,
  parseFile,
} from '../src/ir/schemas.js';

describe('v2 field schema', () => {
  it('accepts a field with type: <single-segment>', () => {
    const yaml = `version: loom-schema/v2
name: M
fields:
  - name: age
    type: integer
`;
    const f = parseFile(yaml, 'm.mixin.yaml', 'mixin');
    expect(f.kind).toBe('mixin');
    const fields = (f.data as { fields: Array<Record<string, unknown>> }).fields;
    expect(fields[0]?.type).toBe('integer');
  });

  it('accepts a field with type: <three-segment>', () => {
    const yaml = `version: loom-schema/v2
name: M
fields:
  - name: email
    type: base.core.Email
`;
    const f = parseFile(yaml, 'm.mixin.yaml', 'mixin');
    const fields = (f.data as { fields: Array<Record<string, unknown>> }).fields;
    expect(fields[0]?.type).toBe('base.core.Email');
  });

  it('accepts a field with type as a descriptor object', () => {
    const yaml = `version: loom-schema/v2
name: M
fields:
  - name: email
    type:
      ref: string
      args: { max_length: 254 }
      meta: { since: v0.2.0 }
`;
    const f = parseFile(yaml, 'm.mixin.yaml', 'mixin');
    const fields = (f.data as { fields: Array<Record<string, unknown>> }).fields;
    const t = fields[0]?.type as {
      ref: string;
      args: { max_length: number };
      meta: { since: string };
    };
    expect(t.ref).toBe('string');
    expect(t.args.max_length).toBe(254);
    expect(t.meta.since).toBe('v0.2.0');
  });

  it('rejects a field with the v1 base: key', () => {
    const yaml = `version: loom-schema/v2
name: M
fields:
  - name: age
    base: integer
`;
    expect(() => parseFile(yaml, 'm.mixin.yaml', 'mixin')).toThrow();
  });

  it('rejects a field with the v1 ref: key', () => {
    const yaml = `version: loom-schema/v2
name: M
fields:
  - name: email
    ref: type:base.core.Email
`;
    expect(() => parseFile(yaml, 'm.mixin.yaml', 'mixin')).toThrow();
  });

  it('accepts an optional using: list on a type file', () => {
    const yaml = `version: loom-schema/v2
name: Order
form: struct
using:
  - base.core.*
  - retail.pos.types.*
fields:
  - name: value
    type:
      ref: string
      args: { max_length: 100 }
`;
    const f = parseFile(yaml, 'order.type.yaml', 'type');
    const data = f.data as { using?: string[] };
    expect(data.using).toEqual(['base.core.*', 'retail.pos.types.*']);
  });

  it('accepts a file with no using: key (default base.core.* is implicit)', () => {
    const yaml = `version: loom-schema/v2
name: Email
form: struct
fields:
  - name: value
    type:
      ref: string
      args: { max_length: 254 }
`;
    const f = parseFile(yaml, 'email.type.yaml', 'type');
    const data = f.data as { using?: string[] };
    expect(data.using).toBeUndefined();
  });

  it('accepts using: with a single precise name', () => {
    const yaml = `version: loom-schema/v2
name: M
using:
  - base.core.Email
fields:
  - name: x
    type: Email
`;
    const f = parseFile(yaml, 'm.mixin.yaml', 'mixin');
    const data = f.data as { using?: string[] };
    expect(data.using).toEqual(['base.core.Email']);
  });
});

describe('schemas', () => {
  it('parses a scalar type file (form: scalar)', () => {
    const f = parseFile(
      'version: loom-schema/v2\nname: string\nform: scalar\ndescription: s\nproperties:\n  - name: max_length\n    type: integer\n    required: true\n',
      'platform/base/core/string.type.yaml',
      'type',
    );
    expect(f.kind).toBe('type');
    expect(TypeSchema.parse((f as { raw: unknown }).raw)).toBeDefined();
  });

  it('parses a module_manifest', () => {
    const f = parseFile(
      'version: loom-schema/v2\nsystem: base\nmodule: core\nphysical_schema: base_core\n',
      'platform/base/core/manifest.module.yaml',
      'module_manifest',
    );
    expect(f.kind).toBe('module_manifest');
    expect(ModuleManifestSchema.parse((f as { raw: unknown }).raw)).toBeDefined();
  });

  it('parses a single-field struct type', () => {
    const src = `version: loom-schema/v2
name: Email
form: struct
fields:
  - name: value
    type:
      ref: string
      args: { max_length: 254 }
`;
    const f = parseFile(src, 'platform/base/core/email.type.yaml', 'type');
    expect(f.kind).toBe('type');
    const vt = TypeSchema.parse((f as { raw: unknown }).raw);
    expect((vt.fields[0]?.type as { ref: string }).ref).toBe('string');
  });

  it('parses a multi-field struct type with constraints', () => {
    const src = `version: loom-schema/v2
name: Money
form: struct
fields:
  - name: amount
    type:
      ref: decimal
      args: { precision: 18, scale: 4 }
    required: true
  - name: currency_code
    type:
      ref: string
      args: { max_length: 3 }
constraints:
  - kind: check
    expr: amount >= 0
`;
    const f = parseFile(src, 'platform/base/core/money.type.yaml', 'type');
    expect(f.kind).toBe('type');
    expect(() => TypeSchema.parse((f as { raw: unknown }).raw)).not.toThrow();
  });

  it('parses a mixin', () => {
    const src = `version: loom-schema/v2
name: Audit
fields:
  - name: created_at
    type: datetime
    required: true
`;
    expect(() =>
      MixinSchema.parse((parseFile(src, 'audit.mixin.yaml', 'mixin') as { raw: unknown }).raw),
    ).not.toThrow();
  });

  it('parses a table with extension strategy sidecar_eav', () => {
    const src = `version: loom-schema/v2
name: Users
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - name: id
    type: bigint
    required: true
primary_key: [id]
`;
    const f = parseFile(src, 'platform/base/core/users.table.yaml', 'table');
    const t = TableSchema.parse((f as { raw: unknown }).raw);
    expect(t.table.extension.strategy).toBe('sidecar_eav');
  });

  it('parses an entity referencing a primary_table', () => {
    const src = `version: loom-schema/v2
name: User
primary_table: table:base.core.Users
business_keys: [email]
`;
    const f = parseFile(src, 'platform/base/core/user.entity.yaml', 'entity');
    expect(() => EntitySchema.parse((f as { raw: unknown }).raw)).not.toThrow();
  });

  it('parses extension_fields', () => {
    const src = `version: loom-schema/v2
entity: entity:base.core.User
fields:
  - name: nickname
    type:
      ref: string
      args: { max_length: 50 }
    default_scope: tenant
`;
    const f = parseFile(src, 'platform/base/core/user_fields.ext.yaml', 'extension_fields');
    expect(() => ExtensionFieldsSchema.parse((f as { raw: unknown }).raw)).not.toThrow();
  });

  it('parseFile rejects wrong version', () => {
    expect(() => parseFile('version: loom-schema/v9\nname: X\n', 'm.mixin.yaml', 'mixin')).toThrow(
      /version/,
    );
  });

  it('AnyFile is a discriminated union by kind (6 kinds)', () => {
    const cases: AnyFile['kind'][] = [
      'type',
      'module_manifest',
      'mixin',
      'table',
      'entity',
      'extension_fields',
    ];
    expect(new Set(cases).size).toBe(6);
  });

  it('parseFile throws ParseError with the right category', () => {
    try {
      parseFile('version: loom-schema/v9\nname: X\n', 'm.mixin.yaml', 'mixin');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).category).toBe('version');
      expect((e as ParseError).file).toBe('m.mixin.yaml');
    }
    try {
      parseFile(':\n  - :\n  : bad', 'm.mixin.yaml', 'mixin');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).category).toBe('parse');
    }
  });
});

describe('type forms', () => {
  it('parses an enum type (shorthand variants array)', () => {
    const src = `version: loom-schema/v2
name: Status
form: enum
variants: [active, inactive, suspended]
`;
    const f = parseFile(src, 'status.type.yaml', 'type');
    const vt = TypeSchema.parse((f as { raw: unknown }).raw);
    expect(vt.variants).toEqual(['active', 'inactive', 'suspended']);
    expect(vt.fields).toBeUndefined();
  });

  it('parses an enum type (detailed variants)', () => {
    const src = `version: loom-schema/v2
name: Status
form: enum
variants:
  - value: active
    display_name: 活跃
  - value: inactive
`;
    const f = parseFile(src, 'status.type.yaml', 'type');
    const vt = TypeSchema.parse((f as { raw: unknown }).raw);
    expect(vt.variants?.[0]).toEqual({ value: 'active', display_name: '活跃' });
    expect(vt.variants?.[1]).toEqual({ value: 'inactive' });
  });

  it('rejects a struct with variants', () => {
    const src = `version: loom-schema/v2
name: Bad
form: struct
fields:
  - name: x
    type: string
variants: [a, b]
`;
    expect(() =>
      TypeSchema.parse((parseFile(src, 'bad.type.yaml', 'type') as { raw: unknown }).raw),
    ).toThrow();
  });

  it('rejects a struct with no fields', () => {
    const src = `version: loom-schema/v2
name: Empty
form: struct
`;
    expect(() =>
      TypeSchema.parse((parseFile(src, 'empty.type.yaml', 'type') as { raw: unknown }).raw),
    ).toThrow();
  });

  it('rejects an enum with no variants', () => {
    const src = `version: loom-schema/v2
name: EmptyEnum
form: enum
`;
    expect(() =>
      TypeSchema.parse((parseFile(src, 'empty-enum.type.yaml', 'type') as { raw: unknown }).raw),
    ).toThrow();
  });

  it('parses type_parameters on a struct type', () => {
    const src = `version: loom-schema/v2
name: Range
form: struct
type_parameters:
  - name: T
    constraint: value
    default: base.core.integer
    description: element type
fields:
  - name: low
    type: T
  - name: high
    type: T
`;
    const f = parseFile(src, 'range.type.yaml', 'type');
    const vt = TypeSchema.parse((f as { raw: unknown }).raw);
    expect(vt.type_parameters?.[0]?.name).toBe('T');
    expect(vt.type_parameters?.[0]?.constraint).toBe('value');
    expect(vt.type_parameters?.[0]?.default).toBe('base.core.integer');
  });

  it('enforces lowercase scalar names', () => {
    const src = `version: loom-schema/v2
name: BadScalar
form: scalar
properties: []
`;
    expect(() =>
      TypeSchema.parse((parseFile(src, 'bad-scalar.type.yaml', 'type') as { raw: unknown }).raw),
    ).toThrow(/lowercase/);
  });

  it('enforces PascalCase struct names', () => {
    const src = `version: loom-schema/v2
name: lowercase
form: struct
fields:
  - name: x
    type: string
`;
    expect(() =>
      TypeSchema.parse((parseFile(src, 'lowercase.type.yaml', 'type') as { raw: unknown }).raw),
    ).toThrow(/PascalCase/);
  });

  it('rejects a scalar with fields', () => {
    const src = `version: loom-schema/v2
name: badscalar
form: scalar
fields:
  - name: x
    type: string
`;
    expect(() =>
      TypeSchema.parse((parseFile(src, 'badscalar.type.yaml', 'type') as { raw: unknown }).raw),
    ).toThrow();
  });
});
