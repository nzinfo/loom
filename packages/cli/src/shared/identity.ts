/**
 * Identity ↔ file path conversion for write commands.
 *
 * When a write command (new, add field, rm) needs to create or find a file,
 * it must convert a node identity (e.g. `type:shop.core.Money`) to a
 * filesystem path (e.g. `platform/shop/core/money.type.yaml`).
 *
 * The reverse direction (path → identity) is handled by @loom/core's
 * pathToIdentity in the discovery pass. This module handles identity → path
 * and identity → file stem, which the core doesn't need (it's write-only).
 */
import { pascalToKebab } from '@loom/core';
import { KIND_EXTENSIONS } from '@loom/core';
import type { FileKind, Owner } from '@loom/core';

/** Parse an identity string into its components. */
export function parseIdentity(identity: string): { kind: string; fqn: string } | undefined {
  const colon = identity.indexOf(':');
  if (colon < 0) return undefined;
  return { kind: identity.slice(0, colon), fqn: identity.slice(colon + 1) };
}

/**
 * Convert a type/table/entity identity to a relative file path.
 *
 * @param identity  e.g. `type:shop.core.Money`
 * @param owner     the owner (determines the directory prefix)
 * @param basePath  schema root path (prepended to the relative path)
 * @returns absolute file path, or undefined if the identity is malformed
 */
export function identityToPath(
  identity: string,
  owner: Owner,
  basePath: string,
): string | undefined {
  const parsed = parseIdentity(identity);
  if (parsed === undefined) return undefined;

  const { kind, fqn } = parsed;
  const parts = fqn.split('.');
  if (parts.length < 3) return undefined;

  const system = parts[0];
  const module = parts[1];
  if (system === undefined || module === undefined) return undefined;
  const name = parts.slice(2).join('.'); // supports names with dots? unlikely but safe

  const ext = extForKind(kind as FileKind);
  if (ext === undefined) return undefined;

  const stem = pascalToKebab(name);
  const relPath = `${ownerPrefix(owner)}/${system}/${module}/${stem}${ext}`;

  return basePath.endsWith('/') ? `${basePath}${relPath}` : `${basePath}/${relPath}`;
}

/**
 * Convert an extension_fields reference to a file path.
 *
 * Extensions are special: their identity is derived from the file stem, but
 * the file's `entity:` field points to the target entity. For write commands
 * we need to generate a path based on the group name + entity.
 */
export function extensionToPath(
  entityIdentity: string,
  groupName: string,
  owner: Owner,
  basePath: string,
): string {
  const parsed = parseIdentity(entityIdentity);
  const fqn = parsed?.fqn ?? 'unknown.unknown';
  const parts = fqn.split('.');
  const system = parts[0] ?? 'unknown';
  const module = parts[1] ?? 'unknown';

  const stem = pascalToKebab(groupName);
  const relPath = `${ownerPrefix(owner)}/${system}/${module}/${stem}.ext.yaml`;

  return basePath.endsWith('/') ? `${basePath}${relPath}` : `${basePath}/${relPath}`;
}

/** Get the owner directory prefix. */
function ownerPrefix(owner: Owner): string {
  switch (owner.kind) {
    case 'platform':
      return 'platform';
    case 'ext':
      return `ext/${owner.provider}`;
    case 'tenant':
      return `tenants/${owner.id}`;
  }
}

/** File extension for a kind (re-exported for convenience). */
function extForKind(kind: FileKind): string | undefined {
  return KIND_EXTENSIONS[kind];
}
