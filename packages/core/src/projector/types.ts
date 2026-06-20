/**
 * Physical model types. See spec §6.2, §8.4, §11, §7.5.
 *
 * These are the output of the design→physical projector.
 * Each PhysicalTable represents a database table (base, ext, or view).
 */
import type { ExtensionFieldEntry } from '../ir/version.js';

/** Re-exported for projector consumers; source of truth is ir/version.ts. */
export type { ExtensionFieldEntry };

/** Strategy for storing extension_fields. */
export type ExtensionStrategy = 'none' | 'json_column' | 'sidecar_eav';

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
  /** Logical scalar name from base_types (e.g. "decimal", "string", "enum"). */
  readonly scalar: string;
  /** Scalar properties carried through (e.g. precision, scale, max_length). */
  readonly props: Readonly<Record<string, unknown>>;
  /** True if column is NOT NULL. */
  readonly required: boolean;
  /** True if column has a UNIQUE constraint. */
  readonly unique: boolean;
  /**
   * If scalar === 'enum', this is the type identity (e.g.
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
 * Represents either a base table, an extension table (sidecar_eav), or a view.
 */
export interface PhysicalTable {
  /** Simple table name (not schema-qualified). */
  readonly name: string;
  /** module_manifest physical_schema, e.g. "base_core". undefined if no manifest. */
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
  /** Extension strategy (from table.extension.strategy). */
  readonly strategy: ExtensionStrategy;
  /** If strategy=sidecar_eav, the extension table name. */
  readonly extTableName?: string;
  /** If strategy=sidecar_eav, the view name that unions base+ext. */
  readonly viewName?: string;
}

/**
 * The complete physical model for a Loom schema.
 *
 * Contains all physical tables, plus registries for enums and extension_fields.
 */
export interface PhysicalModel {
  /** All physical tables (base + ext + views). */
  readonly tables: ReadonlyArray<PhysicalTable>;
  /** Enum registry: identity → values. Populated from value_types with base='enum'. */
  readonly enums: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Extension fields registry: entity identity → ExtensionFieldEntry array. */
  readonly extensionFields: ReadonlyMap<string, ReadonlyArray<ExtensionFieldEntry>>;
}
