/**
 * Shared load helper — wraps load() with standard error handling.
 *
 * Every read command follows the same pattern: load the schema, check for
 * errors, return the IR or an exit code. This eliminates the duplication.
 */
import process from 'node:process';
import { load } from '@loom/core';
import type { IR } from '@loom/core';
import { NodeFileSystem } from './fs.js';

export interface LoadResult {
  /** The IR if loading succeeded (no errors); undefined if errors occurred. */
  readonly ir: IR | undefined;
  /** Exit code: 0 on success, 1 on load/validation failure. */
  readonly code: number;
}

/**
 * Load a schema and handle diagnostics.
 *
 * On success, returns `{ ir, code: 0 }`.
 * On failure, writes diagnostics to stderr and returns `{ ir: undefined, code: 1 }`.
 */
export async function loadOrError(path: string): Promise<LoadResult> {
  const result = await load({ fs: new NodeFileSystem(), basePath: path });
  if (result.diagnostics.hasErrors) {
    process.stderr.write(result.diagnostics.format());
    process.stderr.write('\n');
    return { ir: undefined, code: 1 };
  }
  return { ir: result.ir, code: 0 };
}
