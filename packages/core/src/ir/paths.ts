/**
 * Path ↔ identity helpers. See spec
 * `2026-06-18-loom-v2-owner-dimension.md` §3, §4.
 *
 * Identity is derived from path position, never from file contents.
 * The discovery layer passes the path relative to the schema root (basePath),
 * including the owner prefix (platform/ ext/ tenants/).
 *
 * The file's kind is encoded in its extension — the SOLE source of kind. The
 * YAML body carries no `kind:` field, and there are no kind subdirectories
 * (flat layout). See spec §9.
 *
 * Layout (relPath includes the owner prefix):
 *   platform/<sys>/<mod>/manifest.module.yaml     → module_manifest:<sys>.<mod>
 *   platform/<sys>/<mod>/<stem>.<kind>.yaml       → <kind>:<sys>.<mod>.<Stem>
 *   ext/<provider>/<sys>/<mod>/manifest.module.yaml → module_manifest:<sys>.<mod>  (owner: ext:<provider>)
 *   ext/<provider>/<sys>/<mod>/<stem>.<kind>.yaml → <kind>:<sys>.<mod>.<Stem>
 *   tenants/<id>/<sys>/<mod>/<stem>.<kind>.yaml   → <kind>:<sys>.<mod>.<Stem>  (owner: tenant:<id>)
 *
 * kind token ∈ { type, mixin, table, entity, ext, module }
 * where `ext`→extension_fields, `module`→module_manifest.
 *
 * There is no longer a singleton base_types file: scalars are ordinary
 * `.type.yaml` files (form: scalar) under platform/base/core/, each with its
 * own identity `type:base.core.<name>`. The `base_types:` collection identity
 * is gone. See `docs/design/2026-06-21-unified-type-kind-notes.md`.
 */
import { EXT_TO_KIND, type FileKind } from './version.js';
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

/**
 * Derive kind from a filename by matching its known kind-encoded suffix.
 * Suffixes are non-overlapping (`.ext.yaml` is checked before a generic
 * `.yaml`). Returns null if the file has no recognized kind token.
 */
export function kindFromFilename(file: string): FileKind | null {
  for (const [ext, kind] of Object.entries(EXT_TO_KIND)) {
    if (file.endsWith(ext)) return kind;
  }
  return null;
}

/**
 * Strip the kind-encoded suffix from a filename, returning the kebab-case
 * stem. E.g. `user.entity.yaml` → `user`, `manifest.module.yaml` → `manifest`,
 * `base.types.yaml` → `base`. Returns null if no known kind suffix matches.
 */
export function stemFromFilename(file: string): string | null {
  for (const ext of Object.keys(EXT_TO_KIND)) {
    if (file.endsWith(ext)) return file.slice(0, -ext.length);
  }
  return null;
}

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

  // ── tenants/<id>/<sys>/<mod>/<stem>.<kind>.yaml ───────────────────────
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
 * same inner layout: [<sys>/<mod>/manifest.module.yaml
 * | <sys>/<mod>/<stem>.<kind>.yaml].
 *
 * Flat: no kind subdirectories. The kind comes from the filename suffix.
 * There is no singleton base_types file — scalars are ordinary .type.yaml.
 */
function parseOwned(inner: string[], owner: Owner): DiscoveredFile | null {
  // <sys>/<mod>/<file>  (3 parts) — kind from filename suffix.
  if (inner.length === 3) {
    const system = inner[0];
    const module = inner[1];
    const file = inner[2];
    if (!system || !module || !file) return null;
    const kind = kindFromFilename(file);
    if (kind === null) return null;
    const stem = stemFromFilename(file);
    if (stem === null) return null;

    // module_manifest has no logical name and must use its canonical filename.
    if (kind === 'module_manifest') {
      if (file !== 'manifest.module.yaml') return null;
      return {
        kind,
        system,
        module,
        name: '',
        identity: `${kind}:${system}.${module}`,
        owner,
      };
    }

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
 * Parse the post-tenant-id portion: <sys>/<mod>/<stem>.<kind>.yaml.
 * Tenants may only write extension_fields (`.ext.yaml`); other kinds are
 * rejected here. The kind comes from the filename suffix, same as platform/ext.
 */
function parseTenant(inner: string[], tenantId: string): DiscoveredFile | null {
  // <sys>/<mod>/<file>  (3 parts)
  if (inner.length !== 3) return null;
  const system = inner[0];
  const module = inner[1];
  const file = inner[2];
  if (!system || !module || !file) return null;
  const kind = kindFromFilename(file);
  if (kind === null) return null;
  // Tenants can only contribute extension_fields.
  if (kind !== 'extension_fields') return null;
  const stem = stemFromFilename(file);
  if (stem === null) return null;
  const name = kebabToPascal(stem);
  const owner: Owner = { kind: 'tenant', id: tenantId };
  return {
    kind,
    system,
    module,
    name,
    identity: `${kind}:${system}.${module}.${name}`,
    owner,
  };
}
