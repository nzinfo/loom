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

/**
 * A loaded schema node. Mirrors `AnyFile` but carries the canonical identity
 * (derived from path) and is fully resolved (refs linked, mixins expanded).
 * See spec §13.
 */
export type IRNode = AnyFile & {
  readonly identity: Identity;
};
