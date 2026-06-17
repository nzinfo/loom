import type { Diagnostics } from '../errors.js';
import { type DiscoveredFile, pathToIdentity } from '../ir/paths.js';
/**
 * Pass 0 — discovery. See spec §13.1.
 *
 * Walks the injected FileSystem, derives identity for every .yaml file from
 * its path, and builds an identity→path map. Files that don't match the
 * layout emit an `identity` diagnostic but do not abort the walk.
 */
import type { FileSystem } from './fs.js';

export interface DiscoveredEntry {
  readonly identity: string;
  readonly path: string;
  readonly meta: DiscoveredFile;
}

export interface DiscoveryResult {
  readonly files: ReadonlyMap<string, DiscoveredEntry>;
}

export interface DiscoverOptions {
  readonly fs: FileSystem;
  readonly basePath: string;
  readonly systemFilter?: readonly string[];
  readonly diagnostics: Diagnostics;
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const files = new Map<string, DiscoveredEntry>();
  const seenPaths = new Set<string>();
  const prefix = opts.basePath.replace(/\\/g, '/').replace(/\/$/, '');

  for await (const abs of opts.fs.listFiles(opts.basePath)) {
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);

    // Strip optional basePath prefix, then the leading `systems/` segment.
    // pathToIdentity expects paths relative to the systems/ directory.
    let rel = abs;
    if (prefix !== '' && abs.startsWith(`${prefix}/`)) {
      rel = abs.slice(prefix.length + 1);
    }
    if (rel.startsWith('systems/')) {
      rel = rel.slice('systems/'.length);
    }

    const meta = pathToIdentity(abs, rel);
    if (meta === null) {
      opts.diagnostics.add({
        category: 'identity',
        file: abs,
        line: 1,
        column: 1,
        message: `path does not match loom-schema/v1 layout: ${rel}`,
      });
      continue;
    }
    if (
      opts.systemFilter !== undefined &&
      meta.system !== '' &&
      !opts.systemFilter.includes(meta.system)
    ) {
      continue;
    }
    if (files.has(meta.identity)) {
      const prev = files.get(meta.identity);
      opts.diagnostics.add({
        category: 'identity',
        file: abs,
        line: 1,
        column: 1,
        message: `duplicate identity ${meta.identity} (also at ${prev?.path ?? '?'})`,
      });
      continue;
    }
    files.set(meta.identity, { identity: meta.identity, path: abs, meta });
  }

  return { files };
}
