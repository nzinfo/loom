import type { Diagnostics } from '../errors.js';
import type { IR } from '../ir/version.js';
/**
 * Loader entry. Implements spec §13.1 four-pass pipeline.
 *
 * Phase 0 (current skeleton): only the API surface exists. Real passes
 * will be filled in during writing-plans execution.
 */
import type { FileSystem } from './fs.js';

export interface LoadOptions {
  /** Injected FS adapter. Required — core never imports node:fs. */
  readonly fs: FileSystem;
  /** Loom schema root directory (contains base_types.yaml + systems/). */
  readonly basePath: string;
  /** Restrict to these systems (faster for partial loads). */
  readonly systemFilter?: readonly string[];
  /** Max parallel file reads. Default 8. */
  readonly maxConcurrency?: number;
}

export interface LoadResult {
  readonly ir: IR;
  readonly diagnostics: Diagnostics;
}

/**
 * Load and validate a loom schema tree.
 *
 * @throws never — all failures surface in `result.diagnostics`. Callers
 *   should check `diagnostics.hasErrors` and decide exit code.
 */
export async function load(_opts: LoadOptions): Promise<LoadResult> {
  // Phase 0 skeleton. Real implementation lands in writing-plans phases.
  throw new Error('not implemented — see docs/specs/2026-06-17-loom-design.md §13');
}
