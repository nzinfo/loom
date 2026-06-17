/**
 * @loom/core public surface.
 *
 * Re-exports the engine's stable API. See spec
 * `docs/specs/2026-06-17-loom-design.md`.
 */
export * from './ir/version.js';
export * from './errors.js';
export { load } from './loader/index.js';
export type { LoadOptions, LoadResult } from './loader/index.js';
export type { FileSystem } from './loader/fs.js';
export * from './ir/refs.js';
export * from './ir/paths.js';
export * from './ir/schemas.js';
export * from './ir/field.js';
export * from './loader/discovery.js';
export * from './loader/parse.js';
export * from './loader/link.js';
export * from './loader/validate.js';
