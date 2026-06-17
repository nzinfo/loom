/**
 * Path ↔ identity helpers. See spec §3.2–3.4.
 *
 * Identity is derived from path position, never from file contents.
 * The discovery layer passes the path relative to the `systems/` directory
 * (or the bare filename for root files). Layout of `relPath`:
 *   base_types.yaml                    → base_types:
 *   <sys>/<mod>/MANIFEST.yaml          → module_manifest:<sys>.<mod>
 *   <sys>/<mod>/<kind>/<name>.yaml     → <kind>:<sys>.<mod>.<Pascal>
 * kind ∈ { value_type, mixin, table, entity, extension_fields }
 * extension_fields files live under <sys>/<mod>/extension/<name>.yaml.
 */
import type { FileKind } from './version.js';

export interface DiscoveredFile {
  readonly kind: FileKind;
  readonly system: string;
  readonly module: string;
  /** PascalCase logical name; empty for base_types and module_manifest. */
  readonly name: string;
  /** Canonical identity string. */
  readonly identity: string;
}

const KIND_DIRS = new Map<string, FileKind>([
  ['value_type', 'value_type'],
  ['mixin', 'mixin'],
  ['table', 'table'],
  ['entity', 'entity'],
  ['extension', 'extension_fields'],
]);

export function kebabToPascal(kebab: string): string {
  return kebab
    .split('-')
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

export function pascalToKebab(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Derive a DiscoveredFile from a path. Returns null if the path does not
 * match any loom-schema/v1 layout (caller emits an `identity` diagnostic).
 *
 * @param fullPath absolute or basePath-relative path (kept for error messages).
 * @param relPath  path relative to the `systems/` directory (or bare filename
 *                 for root files); what we actually parse.
 */
export function pathToIdentity(fullPath: string, relPath: string): DiscoveredFile | null {
  // Reserved for future diagnostics; surfaced up front so it doesn't look dead.
  void fullPath;

  // Root base_types.yaml
  if (relPath === 'base_types.yaml') {
    return { kind: 'base_types', system: '', module: '', name: '', identity: 'base_types:' };
  }

  // The discovery layer strips the leading `systems/` segment before calling
  // this helper, so relPath is one of:
  //   <sys>/<mod>/MANIFEST.yaml        (3 parts)
  //   <sys>/<mod>/<kindDir>/<file>     (4 parts)
  const norm = relPath.replace(/\\/g, '/');
  const parts = norm.split('/');

  if (parts.length === 3 && parts[2] === 'MANIFEST.yaml') {
    const system = parts[0];
    const module = parts[1];
    if (!system || !module) return null;
    return {
      kind: 'module_manifest',
      system,
      module,
      name: '',
      identity: `module_manifest:${system}.${module}`,
    };
  }

  if (parts.length === 4) {
    const system = parts[0];
    const module = parts[1];
    const kindDir = parts[2];
    const file = parts[3];
    if (!system || !module || !kindDir || !file) return null;
    const kind = KIND_DIRS.get(kindDir);
    if (!kind) return null;
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) return null;
    const stem = file.replace(/\.(ya?ml)$/, '');
    const name = kebabToPascal(stem);
    return {
      kind,
      system,
      module,
      name,
      identity: `${kind}:${system}.${module}.${name}`,
    };
  }

  // Allow deeper nesting inside kind dir? Spec is flat under <kind>/. Reject.
  return null;
}
