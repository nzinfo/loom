/**
 * @loom/core — Forward schema description language engine.
 *
 * Design schema → physical schema projector. See
 * `docs/specs/2026-06-17-loom-design.md` for the full specification.
 *
 * This package is environment-agnostic: no Node.js-specific APIs.
 * File system access is injected via the `FileSystem` interface so the
 * same engine can run in browsers, workers, Node, Deno, Bun.
 */
import type { AnyFile } from './schemas.js';

/** Format family written to every schema file's `version:` line. */
export const FORMAT_FAMILY = 'loom-schema' as const;
/** Current wire version. Breaking changes must bump this. */
export const FORMAT_VERSION = 'v2' as const;
/** Full version string written to schema files. */
export const CURRENT_VERSION = `${FORMAT_FAMILY}/${FORMAT_VERSION}` as const;

/** All file kinds recognized by loom-schema/v2. See spec §9.
 *
 * `type` is the unified type-definition kind (scalar / struct / enum via the
 * `form` field). It replaces the former `base_types` (collection kind) and
 * `value_type`. See `docs/design/2026-06-21-unified-type-kind-notes.md`.
 *
 * `module_manifest` is gone — physical_schema is now a projection-time
 * concern (derived from `<system>_<module>`, with optional CLI overrides),
 * not a schema declaration. See design note on module_manifest removal. */
export const FILE_KIND = ['type', 'table', 'entity', 'extension_fields'] as const;
export type FileKind = (typeof FILE_KIND)[number];

/**
 * Kind ↔ file-extension mapping. The file extension is the SOLE source of a
 * file's kind (the YAML body carries no `kind:`; the layout is flat — no kind
 * subdirectories). See spec §9.
 *
 * The kind token sits between the stem and `.yaml`:
 *   `money.type.yaml`, `users.table.yaml`,
 *   `user.entity.yaml`, `user_fields.ext.yaml`
 *
 * Only `.yaml` is supported (not `.yml`) — kind-encoded files standardize on
 * the canonical long extension.
 */
export const KIND_EXTENSIONS: Readonly<Record<FileKind, string>> = {
  type: '.type.yaml',
  table: '.table.yaml',
  entity: '.entity.yaml',
  extension_fields: '.ext.yaml',
};

/** Reverse map: file suffix → kind. Suffixes are non-overlapping. */
export const EXT_TO_KIND: Readonly<Record<string, FileKind>> = Object.fromEntries(
  Object.entries(KIND_EXTENSIONS).map(([kind, ext]) => [ext, kind as FileKind]),
);

/**
 * The form of a `type` node (spec §9). Discriminates how the type is defined:
 *   - `scalar` — a base scalar (bigint, decimal, string, ...) with optional
 *                `properties` declaring the args it accepts. Scalars are the
 *                system base; only defined under base.core. Referenced by
 *                lowercase short name (no `using`).
 *   - `struct` — a composite type with `fields` (one column per field) and
 *                optional `constraints`. Referenced by
 *                PascalCase name via `using`.
 *   - `enum`   — a sum type with `variants`. Referenced by PascalCase name.
 *                Open to future Rust-style evolution (associated data,
 */
export const TYPE_FORMS = ['scalar', 'struct', 'enum'] as const;
export type TypeForm = (typeof TYPE_FORMS)[number];

/**
 * Stable identity string for any schema node.
 * Format: `<kind>:<system>.<module>.<PascalName>`
 * See spec §3.5.
 */
export type Identity = string;

/**
 * The owner dimension — who provides a node. See spec
 * `2026-06-18-loom-v2-owner-dimension.md`.
 *
 * Owner is derived from the directory path (not declared in file content):
 *   platform/<sys>/<mod>/...            → platform
 *   ext/<provider>/<sys>/<mod>/...      → ext:<provider>
 *   tenants/<id>/<sys>/<mod>/...        → tenant:<id>
 *
 * Identity (kind:sys.mod.Name) is unchanged; owner is an orthogonal node
 * attribute. Cross-owner references are implicit (refs carry no owner).
 */
export type Owner =
  | { readonly kind: 'platform' }
  | { readonly kind: 'ext'; readonly provider: string }
  | { readonly kind: 'tenant'; readonly id: string };

/**
 * A single extension_fields entry flattened for registry use.
 *
 * Source of truth lives here (ir/) so the loader's link pass can populate
 * IR.extensionFields without depending on the projector package.
 * projector/types.ts re-exports this as ExtensionFieldEntry.
 */
export interface ExtensionFieldEntry {
  readonly name: string;
  readonly scalar: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly refValueTypeId?: string;
  readonly defaultScope?: string;
}

/** Placeholder — full IR types will be added in implementation phases. */
export interface IR {
  /** Schema files successfully loaded, keyed by Identity. */
  readonly nodes: ReadonlyMap<Identity, IRNode>;
  /** Dependency graph: A → B means A references B. See spec §14. */
  readonly deps: ReadonlyMap<Identity, ReadonlySet<Identity>>;
  /** Format version that was loaded. */
  readonly version: typeof CURRENT_VERSION;
  /**
   * Extension fields registry: entity identity → ExtensionFieldEntry array.
   *
   * Aggregated from all extension_fields files across owners (ext/tenant).
   * Same-name field across owners on the same entity is a hard error
   * (detected during link). See spec §7.
   */
  readonly extensionFields: ReadonlyMap<Identity, ReadonlyArray<ExtensionFieldEntry>>;
}

/**
 * A loaded schema node. Mirrors `AnyFile` but carries the canonical identity
 * (derived from path) and is fully resolved (refs linked, mixins expanded).
 * See spec §13.
 *
 * `owner` is derived from the directory path (platform/ext/tenants prefix).
 * See spec `2026-06-18-loom-v2-owner-dimension.md` §4.
 */
export type IRNode = AnyFile & {
  readonly identity: Identity;
  readonly owner: Owner;
};
