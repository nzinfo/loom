import type { Diagnostics } from '../errors.js';
import { type DiscoveredFile, pathToIdentity } from '../ir/paths.js';
/**
 * Pass 0 — discovery. See spec §13.1 (v2 owner dimension).
 *
 * Walks the injected FileSystem, derives identity + owner for every .yaml
 * file from its path (the owner prefix platform/ ext/ tenants/ is part of
 * the rel path passed to pathToIdentity), and builds a path→entry map.
 *
 * Identity uniqueness is enforced for all kinds EXCEPT extension_fields:
 * multiple owners (platform/ext/tenant) may write extension_fields for
 * the same entity (and even with the same file stem); those aggregate at
 * link time (spec §6.3, §7). Files that don't match the layout emit an
 * `identity` diagnostic but do not abort the walk.
 */
import type { FileSystem } from './fs.js';

export interface DiscoveredEntry {
  readonly identity: string;
  readonly path: string;
  readonly meta: DiscoveredFile;
}

export interface DiscoveryResult {
  /**
   * All discovered files keyed by absolute path (unique).
   * `meta.identity` carries the canonical identity; multiple extension_fields
   * entries may share an identity across owners.
   */
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
  // Tracks identity → first path that claimed it, for duplicate detection.
  // extension_fields identities are exempt (multiple owners may share).
  const identityOwner = new Map<string, string>();
  const seenPaths = new Set<string>();
  const prefix = opts.basePath.replace(/\\/g, '/').replace(/\/$/, '');

  for await (const abs of opts.fs.listFiles(opts.basePath)) {
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);

    // Strip optional basePath prefix. pathToIdentity expects the full rel
    // path including the owner prefix (platform/ ext/ tenants/).
    let rel = abs;
    if (prefix !== '' && abs.startsWith(`${prefix}/`)) {
      rel = abs.slice(prefix.length + 1);
    }

    const meta = pathToIdentity(abs, rel);
    if (meta === null) {
      opts.diagnostics.add({
        category: 'identity',
        file: abs,
        line: 1,
        column: 1,
        message: `path does not match loom-schema/v2 layout: ${rel}`,
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

    // Duplicate-identity check. extension_fields is exempt: multiple owners
    // may extend the same entity, and even reuse the same file stem — those
    // aggregate in the link pass (spec §6.3, §7).
    if (meta.kind !== 'extension_fields') {
      const prev = identityOwner.get(meta.identity);
      if (prev !== undefined) {
        opts.diagnostics.add({
          category: 'identity',
          file: abs,
          line: 1,
          column: 1,
          message: `duplicate identity ${meta.identity} (also at ${prev})`,
        });
        continue;
      }
      identityOwner.set(meta.identity, abs);
    }

    files.set(abs, { identity: meta.identity, path: abs, meta });
  }

  return { files };
}
