import { Diagnostics } from '../errors.js';
import type { IR } from '../ir/version.js';
import { CURRENT_VERSION } from '../ir/version.js';
import { discover } from './discovery.js';
/**
 * Loader entry. Implements spec §13.1 four-pass pipeline.
 */
import type { FileSystem } from './fs.js';
import { link } from './link.js';
import { parseAll } from './parse.js';
import { validate } from './validate.js';

export interface LoadOptions {
  /** Injected FS adapter. Required — core never imports node:fs. */
  readonly fs: FileSystem;
  /** Loom schema root directory (contains base_types.yaml + systems/). */
  readonly basePath: string;
  /** Restrict to these systems (faster for partial loads). */
  readonly systemFilter?: readonly string[];
  /** Max parallel file reads. Reserved for future use; current impl is serial. */
  readonly maxConcurrency?: number;
}

export interface LoadResult {
  readonly ir: IR;
  readonly diagnostics: Diagnostics;
}

/**
 * Load + link + validate a loom schema tree. Never throws — all failures
 * surface in `result.diagnostics`. Callers check `hasErrors` and decide
 * exit code.
 */
export async function load(opts: LoadOptions): Promise<LoadResult> {
  const diagnostics = new Diagnostics();

  // Pass 0 — discovery.
  const { files } = await discover({
    fs: opts.fs,
    basePath: opts.basePath,
    ...(opts.systemFilter !== undefined ? { systemFilter: opts.systemFilter } : {}),
    diagnostics,
  });

  // Pass 1 — parse.
  const { parsed, extensionFieldsFiles } = await parseAll({
    fs: opts.fs,
    files,
    diagnostics,
  });

  // Pass 2 — link. Always run even with parse errors so we surface as many
  // diagnostics as possible; downstream passes operate on the partial map.
  const { ir: linked } = await link({
    parsed,
    extensionFieldsFiles,
    files,
    diagnostics,
  });

  // Pass 3 — validate.
  validate({ ir: linked, diagnostics });

  const ir: IR = {
    nodes: linked.nodes,
    deps: linked.deps,
    version: CURRENT_VERSION,
    extensionFields: linked.extensionFields,
  };
  return { ir, diagnostics };
}
