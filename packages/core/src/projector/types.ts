/**
 * Physical model types. See spec §6.2, §8.4, §11, §7.5.
 *
 * These are the output of the design→physical projector.
 * Each PhysicalTable represents a database table (base, ext, or view).
 */
import type { ExtensionFieldEntry } from '../ir/version.js';
import type { EnumVariant } from './enumMeta.js';

/** Re-exported for projector consumers; source of truth is ir/version.ts. */
export type { ExtensionFieldEntry };
/** Variant with optional metadata; source of truth is projector/enumMeta.ts. */
export type { EnumVariant };

/** Strategy for storing extension_fields.
 * - 'none' / 'json_column' / 'sidecar_eav': legacy table-level strategies (backward compat)
 * - 'sidecar_jsonb' / 'new_table': ext-level strategies (ext-strategy-decoupling) */
export type ExtensionStrategy =
  | 'none'
  | 'json_column'
  | 'sidecar_eav'
  | 'sidecar_jsonb'
  | 'new_table';

/**
 * A physical column in a database table.
 *
 * - Base fields map 1:1 or 1:N (via value_type expansion).
 * - Ref fields to value_types expand similarly.
 * - Mixin includes expand into their constituent fields.
 */
export interface PhysicalColumn {
  /** Column name (may be suffixed for multi-field value_types). */
  readonly name: string;
  /** Logical scalar name from base_types (e.g. "decimal", "string", "enum").
   * For enum columns this is the carrier type (e.g. 'string', 'uint8'). */
  readonly scalar: string;
  /** Scalar properties carried through (e.g. precision, scale, max_length). */
  readonly props: Readonly<Record<string, unknown>>;
  /** True if column is NOT NULL. */
  readonly required: boolean;
  /** True if column has a UNIQUE constraint. */
  readonly unique: boolean;
  /**
   * If scalar references an enum type, this is the type identity (e.g.
   * type:base.core.Status) used to look up the value list in the
   * model's enum registry.
   */
  readonly enumRef?: string;
}

/** A database index. */
export interface PhysicalIndex {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
}

/** A foreign key constraint. */
export interface PhysicalForeignKey {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly refTable: string;
  readonly refColumns: ReadonlyArray<string>;
  readonly onDelete?: 'cascade' | 'restrict' | 'set_null' | 'no_action';
}

/**
 * A physical database table.
 *
 * Represents either a base table, an extension table (sidecar or new_table), or a view.
 */
export interface PhysicalTable {
  /** Simple table name (not schema-qualified). */
  readonly name: string;
  /** Physical schema, derived from `<system>_<module>` (or CLI override). */
  readonly schema: string | undefined;
  /** Fully qualified name: `<schema>.<name>`. */
  readonly qualifiedName: string;
  /** Physical columns (including mixin-expanded, value_type-expanded). */
  readonly columns: ReadonlyArray<PhysicalColumn>;
  /** Primary key column names. */
  readonly primaryKey: ReadonlyArray<string>;
  /** Indexes defined on this table. */
  readonly indexes: ReadonlyArray<PhysicalIndex>;
  /** Foreign keys defined on this table. */
  readonly foreignKeys: ReadonlyArray<PhysicalForeignKey>;
  /** Extension strategy (from table.extension.strategy or ext strategy). */
  readonly strategy: ExtensionStrategy;
  /** If strategy=sidecar_eav/sidecar_jsonb, the extension table name. */
  readonly extTableName?: string;
  /** If strategy=sidecar_eav/sidecar_jsonb, the view name that unions base+ext. */
  readonly viewName?: string;
  /** If strategy=sidecar_jsonb, the base PK column names (for generating
   * base_id_0..N in the ext table). Copied from primaryKey for sidecar tables. */
  readonly sidecarPkColumns?: readonly string[];
  /** If strategy=sidecar_jsonb, the base PK column scalars (parallel to
   * sidecarPkColumns). Drives the base_id_N column TYPE per dialect instead
   * of hardcoding BIGINT/INTEGER. Without this, dialects emit mismatched
   * types (e.g. BIGINT base_id for a VARCHAR base PK → JOIN type errors). */
  readonly sidecarPkScalars?: readonly string[];
  /** Props (max_length, precision, scale, ...) parallel to sidecarPkColumns.
   * Needed because some scalars (string) require args to emit a SQL type. */
  readonly sidecarPkProps?: readonly Readonly<Record<string, unknown>>[];
}

/**
 * An enum type entry in the physical model's enum registry.
 *
 * Holds the carrier (underlying storage scalar) and the variant list.
 */
export interface EnumEntry {
  /** Underlying storage scalar (e.g. 'string', 'uint8', 'int16'). */
  readonly carrier: string;
  /** Variants with optional metadata (display_name/description). */
  readonly variants: ReadonlyArray<EnumVariant>;
}

/**
 * The complete physical model for a Loom schema.
 *
 * Contains all physical tables, plus registries for enums and extension_fields.
 */
export interface PhysicalModel {
  /** All physical tables (base + ext + views). */
  readonly tables: ReadonlyArray<PhysicalTable>;
  /**
   * Enum registry: identity → EnumEntry (carrier + variants).
   * Populated from type nodes with form='enum'. Dialects read the carrier
   * to decide between native ENUM (string) and integer column + CHECK.
   */
  readonly enums: ReadonlyMap<string, EnumEntry>;
  /** Extension fields registry: entity identity → ExtensionFieldEntry array. */
  readonly extensionFields: ReadonlyMap<string, ReadonlyArray<ExtensionFieldEntry>>;
}
