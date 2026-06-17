import { describe, expect, it } from 'vitest';
import {
  type AnyFile,
  BaseTypesSchema,
  EntitySchema,
  ExtensionFieldsSchema,
  MixinSchema,
  ModuleManifestSchema,
  ParseError,
  TableSchema,
  ValueTypeSchema,
  parseFile,
} from '../src/ir/schemas.js';

describe('v2 field schema', () => {
  it('accepts a field with type: <single-segment>', () => {
    const yaml = `version: loom-schema/v2
kind: mixin
name: M
fields:
  - name: age
    type: integer
`;
    const f = parseFile(yaml, 'test.yaml');
    expect(f.kind).toBe('mixin');
    const fields = (f.data as { fields: Array<Record<string, unknown>> }).fields;
    expect(fields[0]?.type).toBe('integer');
    expect((fields[0] as Record<string, unknown>).base).toBeUndefined();
    expect((fields[0] as Record<string, unknown>).ref).toBeUndefined();
  });

  it('accepts a field with type: <three-segment>', () => {
    const yaml = `version: loom-schema/v2
kind: mixin
name: M
fields:
  - name: email
    type: base.core.Email
`;
    const f = parseFile(yaml, 'test.yaml');
    const fields = (f.data as { fields: Array<Record<string, unknown>> }).fields;
    expect(fields[0]?.type).toBe('base.core.Email');
  });

  it('rejects a field with the v1 base: key', () => {
    const yaml = `version: loom-schema/v2
kind: mixin
name: M
fields:
  - name: age
    base: integer
`;
    expect(() => parseFile(yaml, 'test.yaml')).toThrow();
  });

  it('rejects a field with the v1 ref: key', () => {
    const yaml = `version: loom-schema/v2
kind: mixin
name: M
fields:
  - name: email
    ref: value_type:base.core.Email
`;
    expect(() => parseFile(yaml, 'test.yaml')).toThrow();
  });
});

describe('schemas', () => {
  it('parses base_types.yaml', () => {
    const f = parseFile(
      'version: loom-schema/v1\nkind: base_types\nscalars:\n  - name: string\n    description: s\n    properties:\n      - name: max_length\n        type: integer\n        required: true\n',
      'base_types.yaml',
    );
    expect(f.kind).toBe('base_types');
    expect(BaseTypesSchema.parse((f as { raw: unknown }).raw)).toBeDefined();
  });

  it('parses a single-field value_type', () => {
    const src = `version: loom-schema/v1
kind: value_type
name: Email
fields:
  - name: value
    base: string
    max_length: 254
`;
    const f = parseFile(src, 'systems/base/core/value_type/email.yaml');
    expect(f.kind).toBe('value_type');
    const vt = ValueTypeSchema.parse((f as { raw: unknown }).raw);
    expect(vt.fields[0]?.base).toBe('string');
  });

  it('parses a multi-field value_type with constraints', () => {
    const src = `version: loom-schema/v1
kind: value_type
name: Money
fields:
  - name: amount
    base: decimal
    precision: 18
    scale: 4
    required: true
  - name: currency_code
    base: string
    max_length: 3
constraints:
  - kind: check
    expr: amount >= 0
`;
    const f = parseFile(src, 'systems/base/core/value_type/money.yaml');
    expect(f.kind).toBe('value_type');
    expect(() => ValueTypeSchema.parse((f as { raw: unknown }).raw)).not.toThrow();
  });

  it('rejects a field with both base and ref', () => {
    const src = `version: loom-schema/v1
kind: value_type
name: Bad
fields:
  - name: x
    base: string
    ref: value_type:base.core.Email
`;
    expect(() => parseFile(src, 'systems/base/core/value_type/bad.yaml')).toThrow(/base and ref/);
  });

  it('parses a mixin', () => {
    const src = `version: loom-schema/v1
kind: mixin
name: Audit
fields:
  - name: created_at
    base: datetime
    required: true
`;
    expect(() => MixinSchema.parse((parseFile(src, 'x') as { raw: unknown }).raw)).not.toThrow();
  });

  it('parses a table with extension strategy sidecar_eav', () => {
    const src = `version: loom-schema/v1
kind: table
name: Users
table:
  name: users_base
  extension:
    strategy: sidecar_eav
    ext_table: users_ext
    view: users
fields:
  - name: id
    base: bigint
    required: true
primary_key: [id]
`;
    const f = parseFile(src, 'systems/base/core/table/users.yaml');
    const t = TableSchema.parse((f as { raw: unknown }).raw);
    expect(t.table.extension.strategy).toBe('sidecar_eav');
  });

  it('parses an entity referencing a primary_table', () => {
    const src = `version: loom-schema/v1
kind: entity
name: User
primary_table: table:base.core.Users
business_keys: [email]
`;
    const f = parseFile(src, 'systems/base/core/entity/user.yaml');
    expect(() => EntitySchema.parse((f as { raw: unknown }).raw)).not.toThrow();
  });

  it('parses extension_fields', () => {
    const src = `version: loom-schema/v1
kind: extension_fields
entity: entity:base.core.User
fields:
  - name: nickname
    base: string
    max_length: 50
    default_scope: tenant
`;
    const f = parseFile(src, 'systems/base/core/extension/user_fields.yaml');
    expect(() => ExtensionFieldsSchema.parse((f as { raw: unknown }).raw)).not.toThrow();
  });

  it('parseFile rejects wrong version', () => {
    expect(() => parseFile('version: loom-schema/v9\nkind: mixin\nname: X\n', 'x')).toThrow(
      /version/,
    );
  });

  it('parseFile rejects unknown kind', () => {
    expect(() => parseFile('version: loom-schema/v1\nkind: bogus\nname: X\n', 'x')).toThrow(/kind/);
  });

  it('AnyFile is a discriminated union by kind', () => {
    const cases: AnyFile['kind'][] = [
      'base_types',
      'module_manifest',
      'value_type',
      'mixin',
      'table',
      'entity',
      'extension_fields',
    ];
    expect(new Set(cases).size).toBe(7);
  });

  it('parseFile throws ParseError with the right category', () => {
    try {
      parseFile('version: loom-schema/v9\nkind: mixin\nname: X\n', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).category).toBe('version');
      expect((e as ParseError).file).toBe('x');
    }
    try {
      parseFile('version: loom-schema/v1\nkind: bogus\nname: X\n', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).category).toBe('kind');
    }
    try {
      parseFile(':\n  - :\n  : bad', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).category).toBe('parse');
    }
  });
});
