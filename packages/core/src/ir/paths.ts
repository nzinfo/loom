/**
 * Path ↔ identity helpers. See spec
 * `2026-06-18-loom-v2-owner-dimension.md` §3, §4.
 *
 * Identity is derived from path position, never from file contents.
 * The discovery layer passes the path relative to the schema root (basePath),
 * including the owner prefix (platform/ ext/ tenants/).
 *
 * Layout (relPath includes the owner prefix):
 *   platform/base/core/base_types.yaml            → base_types:           (owner: platform)
 *   platform/<sys>/<mod>/MANIFEST.yaml            → module_manifest:<sys>.<mod>
 *   platform/<sys>/<mod>/<kind>/<name>.yaml       → <kind>:<sys>.<mod>.<Name>
 *   ext/<provider>/<sys>/<mod>/MANIFEST.yaml      → module_manifest:<sys>.<mod>  (owner: ext:<provider>)
 *   ext/<provider>/<sys>/<mod>/<kind>/<name>.yaml → <kind>:<sys>.<mod>.<Name>
 *   tenants/<id>/<sys>/<mod>/<name>_fields.yaml   → extension_fields:<sys>.<mod>.<Name>  (owner: tenant:<id>)
 *
 * kind ∈ { value_type, mixin, table, entity, extension_fields }
 * extension_fields files live under <sys>/<mod>/extension/<name>.yaml for
 * platform/ext, and directly under <sys>/<mod>/ for tenants (no kind dir).
 *
 * base_types.yaml is valid ONLY at platform/base/core/base_types.yaml.
 */
import type { FileKind } from './version.js';
import type { Owner } from './version.js';

export interface DiscoveredFile {
  readonly kind: FileKind;
  readonly system: string;
  readonly module: string;
  /** PascalCase logical name; empty for base_types and module_manifest. */
  readonly name: string;
  /** Canonical identity string. */
  readonly identity: string;
  /** Who provides this node — derived from the path's owner prefix. */
  readonly owner: Owner;
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
 * match any loom-schema/v2 owner-aware layout (caller emits an `identity`
 * diagnostic).
 *
 * @param fullPath absolute or basePath-relative path (kept for error messages).
 * @param relPath  path relative to the schema root, INCLUDING the owner
 *                 prefix (platform/ ext/ tenants/).
 */
export function pathToIdentity(fullPath: string, relPath: string): DiscoveredFile | null {
  // Reserved for future diagnostics; surfaced up front so it doesn't look dead.
  void fullPath;

  const norm = relPath.replace(/\\/g, '/');
  const parts = norm.split('/').filter((p) => p.length > 0);

  if (parts.length === 0) return null;

  const ownerPrefix = parts[0];

  // ── platform/<sys>/<mod>/... ──────────────────────────────────────────
  if (ownerPrefix === 'platform') {
    return parseOwned(parts.slice(1), { kind: 'platform' });
  }

  // ── ext/<provider>/<sys>/<mod>/... ────────────────────────────────────
  if (ownerPrefix === 'ext') {
    const rest = parts.slice(1);
    if (rest.length === 0) return null;
    const provider = rest[0];
    if (!provider) return null;
    return parseOwned(rest.slice(1), { kind: 'ext', provider });
  }

  // ── tenants/<id>/<sys>/<mod>/<name>_fields.yaml (no kind dir) ─────────
  if (ownerPrefix === 'tenants') {
    const rest = parts.slice(1);
    if (rest.length === 0) return null;
    const tenantId = rest[0];
    if (!tenantId) return null;
    return parseTenant(rest.slice(1), tenantId);
  }

  // Legacy bare base_types.yaml or systems/ paths — no longer valid in v2
  // with the owner dimension. Callers emit an identity diagnostic.
  return null;
}

/**
 * Parse the post-owner-prefix portion for platform/ext. These two share the
 * same inner layout: [<sys>/<mod>/MANIFEST.yaml | <sys>/<mod>/base_types.yaml
 * (platform only) | <sys>/<mod>/<kind>/<name>.yaml].
 */
function parseOwned(inner: string[], owner: Owner): DiscoveredFile | null {
  // platform/base/core/base_types.yaml
  if (
    owner.kind === 'platform' &&
    inner.length === 3 &&
    inner[0] === 'base' &&
    inner[1] === 'core' &&
    inner[2] === 'base_types.yaml'
  ) {
    return {
      kind: 'base_types',
      system: 'base',
      module: 'core',
      name: '',
      identity: 'base_types:',
      owner,
    };
  }

  // <sys>/<mod>/MANIFEST.yaml  (3 parts)
  if (inner.length === 3 && inner[2] === 'MANIFEST.yaml') {
    const system = inner[0];
    const module = inner[1];
    if (!system || !module) return null;
    return {
      kind: 'module_manifest',
      system,
      module,
      name: '',
      identity: `module_manifest:${system}.${module}`,
      owner,
    };
  }

  // <sys>/<mod>/<kindDir>/<file>  (4 parts)
  if (inner.length === 4) {
    const system = inner[0];
    const module = inner[1];
    const kindDir = inner[2];
    const file = inner[3];
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
      owner,
    };
  }

  return null;
}

/**
 * Parse the post-tenant-id portion: <sys>/<mod>/<name>_fields.yaml.
 * Tenant files are always extension_fields; there is no kind subdirectory.
 */
function parseTenant(inner: string[], tenantId: string): DiscoveredFile | null {
  // <sys>/<mod>/<file>  (3 parts)
  if (inner.length !== 3) return null;
  const system = inner[0];
  const module = inner[1];
  const file = inner[2];
  if (!system || !module || !file) return null;
  if (!file.endsWith('.yaml') && !file.endsWith('.yml')) return null;
  const stem = file.replace(/\.(ya?ml)$/, '');
  const name = kebabToPascal(stem);
  const owner: Owner = { kind: 'tenant', id: tenantId };
  return {
    kind: 'extension_fields',
    system,
    module,
    name,
    identity: `extension_fields:${system}.${module}.${name}`,
    owner,
  };
}
