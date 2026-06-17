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

/** Format family written to every schema file's `version:` line. */
export const FORMAT_FAMILY = 'loom-schema' as const;
/** Current wire version. Breaking changes must bump this. */
export const FORMAT_VERSION = 'v1' as const;
/** Full version string written to schema files. */
export const CURRENT_VERSION = `${FORMAT_FAMILY}/${FORMAT_VERSION}` as const;

/** All file kinds recognized by loom-schema/v1. See spec §9. */
export const FILE_KIND = [
  'base_types',
  'module_manifest',
  'value_type',
  'mixin',
  'table',
  'entity',
  'extension_fields',
] as const;
export type FileKind = (typeof FILE_KIND)[number];

/**
 * Stable identity string for any schema node.
 * Format: `<kind>:<system>.<module>.<PascalName>`
 * See spec §3.5.
 */
export type Identity = string;

/** Placeholder — full IR types will be added in implementation phases. */
export interface IR {
  /** Schema files successfully loaded, keyed by Identity. */
  readonly nodes: ReadonlyMap<Identity, IRNode>;
  /** Dependency graph: A → B means A references B. See spec §14. */
  readonly deps: ReadonlyMap<Identity, ReadonlySet<Identity>>;
  /** Format version that was loaded. */
  readonly version: typeof CURRENT_VERSION;
}

/** Discriminated union placeholder for all schema node kinds. */
export type IRNode =
  | { readonly kind: 'base_types'; readonly identity: Identity }
  | { readonly kind: 'module_manifest'; readonly identity: Identity }
  | { readonly kind: 'value_type'; readonly identity: Identity }
  | { readonly kind: 'mixin'; readonly identity: Identity }
  | { readonly kind: 'table'; readonly identity: Identity }
  | { readonly kind: 'entity'; readonly identity: Identity }
  | { readonly kind: 'extension_fields'; readonly identity: Identity };
