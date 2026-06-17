/**
 * Zod schemas for each file kind + a discriminated union of parsed files.
 * See spec §3–7, §9, §10.
 *
 * These schemas are the per-file shape contract. Cross-file semantic rules
 * (dangling $ref, mixin cycle, primary_key required) live in the validator.
 *
 * `base`/`ref` mutex (spec §10) is enforced per-field via a Zod refinement.
 */
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';
import { CURRENT_VERSION, FILE_KIND, type FileKind } from './version.js';

const versionSchema = z.literal(CURRENT_VERSION);

const baseField = z
  .object({
    name: z.string().min(1),
    base: z.string().min(1),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .catchall(z.unknown());

const refField = z
  .object({
    name: z.string().min(1),
    ref: z.string().min(1),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .catchall(z.unknown());

const includeEntry = z.object({ include: z.string().min(1) }).strict();

const fieldOrInclude = z.union([baseField, refField, includeEntry]).superRefine((val, ctx) => {
  if ('base' in val && 'ref' in val) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'field cannot have both base and ref (spec §10)',
    });
  }
});

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
    kind: z.literal('base_types'),
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
    kind: z.literal('module_manifest'),
    system: z.string().min(1),
    module: z.string().min(1),
    physical_schema: z.string().min(1),
    description: z.string().optional(),
    exports: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ValueTypeSchema = z
  .object({
    version: versionSchema,
    kind: z.literal('value_type'),
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
    fields: z.array(fieldOrInclude).min(1),
    constraints: z.array(constraintSchema).optional(),
  })
  .strict();

export const MixinSchema = z
  .object({
    version: versionSchema,
    kind: z.literal('mixin'),
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
    fields: z.array(fieldOrInclude).min(1),
  })
  .strict();

export const TableSchema = z
  .object({
    version: versionSchema,
    kind: z.literal('table'),
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
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
    kind: z.literal('entity'),
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().optional(),
    primary_table: z.string().min(1),
    business_keys: z.array(z.string().min(1)).optional(),
    audit: z.boolean().optional(),
  })
  .strict();

export const ExtensionFieldsSchema = z
  .object({
    version: versionSchema,
    kind: z.literal('extension_fields'),
    entity: z.string().min(1),
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
 * Parse a single file's text into an AnyFile. Throws on version/kind mismatch
 * or schema violation. The loader wraps thrown errors into `parse` diagnostics.
 *
 * `file` is the basePath-relative path for error messages; line/column default
 * to 1:1 — the YAML parser supplies real positions in Pass 1.
 */
export function parseFile(text: string, file: string): AnyFile {
  const raw = yamlParse(text);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`parse: ${file}: not a YAML mapping`);
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== CURRENT_VERSION) {
    throw new Error(`version: ${file}: expected ${CURRENT_VERSION}, got ${String(version)}`);
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(kind in SCHEMA_BY_KIND)) {
    throw new Error(`kind: ${file}: unknown kind ${String(kind)}`);
  }
  const schema = SCHEMA_BY_KIND[kind as FileKind];
  const data = schema.parse(raw);
  return { kind: kind as FileKind, raw, file, line: 1, column: 1, data } as AnyFile;
}

// FILE_KIND is re-exported through version.ts; keep the import used so tree-shaking
// and future kind-enum derivations stay consistent.
void FILE_KIND;
