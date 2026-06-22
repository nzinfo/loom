/**
 * Zod schemas for each file kind + a discriminated union of parsed files.
 * See spec §3–7, §9, §10.
 *
 * These schemas are the per-file shape contract. Cross-file semantic rules
 * (dangling $ref, mixin cycle, primary_key required) live in the validator.
 *
 * Fields use a single `type:` key (spec v2 §3); form discrimination between
 * single-segment scalar short names and three-segment type refs happens in
 * the typespace resolver, not here. The unified `type` kind carries a `form`
 * field (scalar/struct/enum) — see `docs/design/2026-06-21-unified-type-kind-notes.md`.
 */
//
// ── Adding a new file kind ──────────────────────────────────────────
// To add a new kind, touch ALL of these (missing any one causes silent bugs):
//   1. version.ts → FILE_KIND array
//   2. version.ts → KIND_EXTENSIONS map (extension token for this kind)
//   3. schemas.ts → new `XxxSchema` export
//   4. schemas.ts → inferred `type Xxx = z.infer<...>`
//   5. schemas.ts → new arm in `AnyFile` union
//   6. schemas.ts → entry in `SCHEMA_BY_KIND`
// ────────────────────────────────────────────────────────────────────
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';
import { CURRENT_VERSION, FILE_KIND, type FileKind, TYPE_FORMS, type TypeForm } from './version.js';

/** Category of failure surfaced by {@link parseFile}. */
export type ParseErrorCategory = 'parse' | 'version';

/**
 * Typed error thrown by {@link parseFile}. The Pass 1 loader catches this
 * and routes the category into a Diagnostic. Plain YAML syntax errors are
 * wrapped as category 'parse'.
 */
export class ParseError extends Error {
  readonly category: ParseErrorCategory;
  readonly file: string;
  constructor(category: ParseErrorCategory, file: string, message: string) {
    super(`${category}: ${file}: ${message}`);
    this.name = 'ParseError';
    this.category = category;
    this.file = file;
  }
}

const versionSchema = z.literal(CURRENT_VERSION);

/**
 * Optional per-file type imports. See spec v2 §4.
 *
 * Each entry is a string:
 *   - `<ns>.*`  → import all types from namespace `<ns>` (module wildcard)
 *   - `<fqtn>`  → import a single type by fully-qualified name
 *
 * Default `base.core.*` is implicit (injected by the link pass) and never
 * written in files.
 */
const usingSchema = z.array(z.string().min(1)).optional();

/**
 * Type descriptor — the structured form of a field's `type:` (spec v2 §3).
 *
 *   ref   — type reference: single-segment (scalar short name) or
 *           three-segment (type fqn sys.mod.Name)
 *   args  — type arguments (max_length, precision, scale, pattern, ...).
 *           Unified home for both value params (literals) and type params
 *           (type refs); discrimination happens at resolution.
 *   meta  — opaque metadata bag (since, deprecated, tags, ...). Not
 *           schema-validated in v2; reserved for future tightening.
 *
 * The string shorthand `type: integer` is normalized to
 * `{ ref: 'integer', args: {}, meta: {} }` by {@link normalizeType} in
 * typespace.ts before any downstream pass consumes it.
 */
export const TypeDescriptorSchema = z
  .object({
    ref: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type TypeDescriptor = z.infer<typeof TypeDescriptorSchema>;

/**
 * A field with a type reference (spec v2 §3).
 *
 * `type:` accepts two forms:
 *   - shorthand: a bare string (`integer`, `base.core.Email`)
 *   - detailed:  a {@link TypeDescriptor} object (`{ref, args, meta}`)
 *
 * The loader's link pass normalizes the shorthand to the descriptor form,
 * so downstream passes always see an object. Scalar arguments live in
 * `type.args`, not at field top level.
 */
const typeField = z
  .object({
    name: z.string().min(1),
    type: z.union([z.string().min(1), TypeDescriptorSchema]),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: z.unknown().optional(),
    default_scope: z.string().min(1).optional(),
    /** Physical column name / prefix override. Default = name. Empty string
     * ('') = flatten: target's fields are inserted without a prefix (the
     * mixin-flatten behavior, now expressed via a struct ref with column: ''). */
    column: z.string().optional(),
  })
  .strict();

/**
 * A variant entry — element of an `enum` form type's `variants:` list (spec v2 §6).
 *
 * Two equivalent forms:
 *   - shorthand: a bare string (`active`)
 *   - detailed:  `{ value: active, display_name: 活跃, description: ... }`
 *
 * Reader normalizes the shorthand to `{ value: <str> }`.
 */
const variantSchema = z.union([
  z.string().min(1),
  z
    .object({
      value: z.string().min(1),
      display_name: z.string().optional(),
      description: z.string().optional(),
    })
    .strict(),
]);

const constraintSchema = z.object({ kind: z.literal('check'), expr: z.string().min(1) }).strict();

const indexSchema = z
  .object({
    name: z.string().min(1),
    fields: z.array(z.string().min(1)).min(1),
    unique: z.boolean().optional(),
  })
  .strict();

const foreignKeySchema = z
  .object({
    name: z.string().min(1),
    fields: z.array(z.string().min(1)).min(1),
    ref_table: z.string().min(1),
    ref_fields: z.array(z.string().min(1)).min(1),
    on_delete: z.enum(['cascade', 'restrict', 'set_null', 'no_action']).optional(),
  })
  .strict();

const extensionSchema = z
  .object({
    strategy: z.enum(['none', 'json_column', 'sidecar_eav']),
    ext_table: z.string().min(1).optional(),
  })
  .strict();

const scalarPropertySchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();

export const TypeSchema = z
  .object({
    version: versionSchema,
    name: z.string().min(1),
    form: z.enum(TYPE_FORMS),
    display_name: z.string().optional(),
    description: z.string().optional(),
    using: usingSchema,
    // Form-specific fields (all optional; superRefine enforces the mutex).
    properties: z.array(scalarPropertySchema).optional(), // scalar
    fields: z.array(typeField).optional(), // struct
    variants: z.array(variantSchema).min(1).optional(), // enum (current shape)
    constraints: z.array(constraintSchema).optional(), // struct only
  })
  .strict()
  .superRefine((data, ctx) => {
    // Name-case convention (compile-time enforced): scalar lowercase,
    // struct/enum PascalCase.
    if (data.form === 'scalar' && !/^[a-z][a-z0-9_]*$/.test(data.name)) {
      ctx.addIssue({
        code: 'custom',
        message: `scalar type name must be lowercase (got "${data.name}")`,
        path: ['name'],
      });
    }
    if (
      (data.form === 'struct' || data.form === 'enum') &&
      !/^[A-Z][A-Za-z0-9_]*$/.test(data.name)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `${data.form} type name must be PascalCase (got "${data.name}")`,
        path: ['name'],
      });
    }

    const has = (k: 'properties' | 'fields' | 'variants' | 'constraints') => data[k] !== undefined;

    if (data.form === 'scalar') {
      if (has('fields') || has('variants') || has('constraints')) {
        ctx.addIssue({
          code: 'custom',
          message: 'scalar type must not have fields/variants/constraints',
          path: ['form'],
        });
      }
    } else if (data.form === 'struct') {
      if (has('properties') || has('variants')) {
        ctx.addIssue({
          code: 'custom',
          message: 'struct type must not have properties/variants',
          path: ['form'],
        });
      }
      if (!has('fields')) {
        ctx.addIssue({
          code: 'custom',
          message: 'struct type must have fields',
          path: ['fields'],
        });
      }
    } else {
      // enum
      if (has('properties') || has('fields') || has('constraints')) {
        ctx.addIssue({
          code: 'custom',
          message: 'enum type must not have properties/fields/constraints',
          path: ['form'],
        });
      }
      if (!has('variants')) {
        ctx.addIssue({
          code: 'custom',
          message: 'enum type must have variants',
          path: ['variants'],
        });
      }
    }
  });

export const TableSchema = z
  .object({
    version: versionSchema,
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
    using: usingSchema,
    table: z
      .object({
        name: z.string().min(1),
        extension: extensionSchema,
      })
      .strict(),
    fields: z.array(typeField).min(1),
    primary_key: z.array(z.string().min(1)).min(1),
    foreign_keys: z.array(foreignKeySchema).optional(),
    indexes: z.array(indexSchema).optional(),
    constraints: z.array(constraintSchema).optional(),
  })
  .strict();

export const EntitySchema = z
  .object({
    version: versionSchema,
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
    using: usingSchema,
    primary_table: z.string().min(1),
    business_keys: z.array(z.string().min(1)).optional(),
    audit: z.boolean().optional(),
    /** View name for the entity's logical view over sidecar_eav tables.
     * Defined on entity (not table) because the view is the entity's physical
     * projection — it unifies base + ext into the entity's complete field set.
     * Omitted = no view created. */
    view: z.string().min(1).optional(),
  })
  .strict();

export const ExtensionFieldsSchema = z
  .object({
    version: versionSchema,
    entity: z.string().min(1),
    /** Extension group name. Fields in the same group are packed into one
     * JSONB row in the ext table. Optional — defaults to the file stem. */
    group: z.string().min(1).optional(),
    using: usingSchema,
    fields: z.array(typeField).min(1),
  })
  .strict();

// ---- inferred types ----

export type TypeNode = z.infer<typeof TypeSchema>;
export type Table = z.infer<typeof TableSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type ExtensionFields = z.infer<typeof ExtensionFieldsSchema>;

// ---- discriminated union + parse entry ----

export interface ParsedFileBase {
  readonly kind: FileKind;
  readonly raw: unknown;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export type AnyFile =
  | (ParsedFileBase & { kind: 'type'; data: TypeNode })
  | (ParsedFileBase & { kind: 'table'; data: Table })
  | (ParsedFileBase & { kind: 'entity'; data: Entity })
  | (ParsedFileBase & { kind: 'extension_fields'; data: ExtensionFields });

const SCHEMA_BY_KIND = {
  type: TypeSchema,
  table: TableSchema,
  entity: EntitySchema,
  extension_fields: ExtensionFieldsSchema,
} as const;

/**
 * Parse a single file's text into an AnyFile. Throws {@link ParseError} on
 * version mismatch, schema violation, or YAML syntax error. The Pass 1
 * loader catches ParseError and routes `category` into a Diagnostic.
 *
 * `kind` is provided by the caller — it is derived from the file extension
 * during discovery (the sole source of kind; the YAML body carries no `kind:`
 * field). `file` is the basePath-relative path for error messages; line/column
 * default to 1:1 — the YAML parser supplies real positions in Pass 1.
 */
export function parseFile(text: string, file: string, kind: FileKind): AnyFile {
  let raw: unknown;
  try {
    raw = yamlParse(text);
  } catch (e) {
    throw new ParseError('parse', file, `YAML syntax: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ParseError('parse', file, 'not a YAML mapping');
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== CURRENT_VERSION) {
    throw new ParseError('version', file, `expected ${CURRENT_VERSION}, got ${String(version)}`);
  }
  const schema = SCHEMA_BY_KIND[kind];
  let data: unknown;
  try {
    data = schema.parse(raw);
  } catch (e) {
    // Zod errors carry full path information; surface the first issue.
    const zodErr = e as { errors?: Array<{ message: string }> };
    const first = zodErr.errors?.[0]?.message ?? (e as Error).message;
    throw new ParseError('parse', file, `schema: ${first}`);
  }
  return { kind, raw, file, line: 1, column: 1, data } as AnyFile;
}

// FILE_KIND is re-exported through version.ts; keep the import used so tree-shaking
// and future kind-enum derivations stay consistent.
void FILE_KIND;
