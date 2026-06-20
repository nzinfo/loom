/**
 * Zod schemas for each file kind + a discriminated union of parsed files.
 * See spec §3–7, §9, §10.
 *
 * These schemas are the per-file shape contract. Cross-file semantic rules
 * (dangling $ref, mixin cycle, primary_key required) live in the validator.
 *
 * Fields use a single `type:` key (spec v2 §3); form discrimination between
 * single-segment base_types names and three-segment value_type refs happens
 * in the typespace resolver, not here.
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
import { CURRENT_VERSION, FILE_KIND, type FileKind } from './version.js';

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
 *   ref   — type reference: single-segment (base_types short name) or
 *           three-segment (value_type fqn)
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
  })
  .strict();

const includeEntry = z.object({ include: z.string().min(1) }).strict();

const fieldOrInclude = z.union([typeField, includeEntry]);

/**
 * A variant entry — element of a value_type's `variants:` list (spec v2 §6).
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

/**
 * A type parameter declaration on a value_type (spec v2 §X).
 *
 *   name        — the parameter identifier (referenced in fields as type: <name>)
 *   constraint  — 'type' (any type, incl. another type parameter — for
 *                 generic recursion like Map<K,V>) or 'value' (must be a
 *                 concrete type: scalar short name or value_type fqn).
 *                 Defaults to 'type'.
 *   default     — default type used when the reference omits this param
 *   description — human-readable note
 *
 * v2 allows declaring type_parameters AND referencing them in fields AND
 * passing args at reference sites (full generic form).
 */
const typeParameterSchema = z
  .object({
    name: z.string().min(1),
    constraint: z.enum(['type', 'value']).optional(),
    default: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

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
    view: z.string().min(1).optional(),
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

export const BaseTypesSchema = z
  .object({
    version: versionSchema,
    using: usingSchema,
    scalars: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            properties: z.array(scalarPropertySchema).default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const ModuleManifestSchema = z
  .object({
    version: versionSchema,
    system: z.string().min(1),
    module: z.string().min(1),
    physical_schema: z.string().min(1),
    description: z.string().optional(),
    using: usingSchema,
    exports: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ValueTypeSchema = z
  .object({
    version: versionSchema,
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
    using: usingSchema,
    fields: z.array(fieldOrInclude).optional(),
    variants: z.array(variantSchema).min(1).optional(),
    type_parameters: z.array(typeParameterSchema).optional(),
    constraints: z.array(constraintSchema).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // fields and variants are mutually exclusive; exactly one required.
    const hasFields = data.fields !== undefined && data.fields.length > 0;
    const hasVariants = data.variants !== undefined && data.variants.length > 0;
    if (hasFields && hasVariants) {
      ctx.addIssue({
        code: 'custom',
        message: 'value_type cannot have both fields and variants (they are mutually exclusive)',
        path: ['variants'],
      });
    }
    if (!hasFields && !hasVariants) {
      ctx.addIssue({
        code: 'custom',
        message: 'value_type must have either fields or variants',
        path: ['fields'],
      });
    }
  });

export const MixinSchema = z
  .object({
    version: versionSchema,
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
    using: usingSchema,
    fields: z.array(fieldOrInclude).min(1),
  })
  .strict();

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
    fields: z.array(fieldOrInclude).min(1),
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
  })
  .strict();

export const ExtensionFieldsSchema = z
  .object({
    version: versionSchema,
    entity: z.string().min(1),
    using: usingSchema,
    fields: z.array(fieldOrInclude).min(1),
  })
  .strict();

// ---- inferred types ----

export type BaseTypes = z.infer<typeof BaseTypesSchema>;
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;
export type ValueType = z.infer<typeof ValueTypeSchema>;
export type Mixin = z.infer<typeof MixinSchema>;
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
  | (ParsedFileBase & { kind: 'base_types'; data: BaseTypes })
  | (ParsedFileBase & { kind: 'module_manifest'; data: ModuleManifest })
  | (ParsedFileBase & { kind: 'value_type'; data: ValueType })
  | (ParsedFileBase & { kind: 'mixin'; data: Mixin })
  | (ParsedFileBase & { kind: 'table'; data: Table })
  | (ParsedFileBase & { kind: 'entity'; data: Entity })
  | (ParsedFileBase & { kind: 'extension_fields'; data: ExtensionFields });

const SCHEMA_BY_KIND = {
  base_types: BaseTypesSchema,
  module_manifest: ModuleManifestSchema,
  value_type: ValueTypeSchema,
  mixin: MixinSchema,
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
