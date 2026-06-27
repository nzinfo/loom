/**
 * `loom update table <path> <identity> --extensible <true|false>`
 *
 * Modifies table extension capability. Toggles the top-level `extensible` flag.
 *
 * Also accepts the legacy `--strategy <none|sidecar_eav|json_column>` form for
 * backward compatibility — it maps: sidecar_eav → extensible:true, none → extensible:false.
 *
 * Write-time constraint enforcement:
 *   Disabling extensions (extensible → false) is blocked if the table's entity
 *   has declared extension_fields — the ext data has nowhere to go. The user
 *   must remove the extension fields first (rm extension).
 */
import { load } from '@loom/core';
import { YAMLMap } from 'yaml';
import { NodeFileSystem } from '../shared/fs.js';
import { identityToPath } from '../shared/identity.js';
import { writeError, writeText } from '../shared/output.js';
import { readYamlDoc, writeYamlDoc } from '../yaml/editor.js';

export interface UpdateTableOptions {
  readonly path: string;
  readonly identity: string;
  readonly strategy: string | undefined;
  /** New API: directly set extensible flag. Takes precedence over --strategy. */
  readonly extensible?: string;
}

export async function updateTableCommand(opts: UpdateTableOptions): Promise<number> {
  // Determine target extensible value from either --extensible or legacy --strategy.
  let targetExtensible: boolean;
  if (opts.extensible !== undefined) {
    if (opts.extensible !== 'true' && opts.extensible !== 'false') {
      writeError(`--extensible must be true|false, got "${opts.extensible}"`);
      return 64;
    }
    targetExtensible = opts.extensible === 'true';
  } else if (opts.strategy !== undefined) {
    // Legacy mapping: sidecar_eav → true, none → false, json_column → error.
    if (!['none', 'sidecar_eav', 'json_column'].includes(opts.strategy)) {
      writeError(`strategy must be none|sidecar_eav|json_column, got "${opts.strategy}"`);
      return 64;
    }
    if (opts.strategy === 'json_column') {
      writeError('json_column strategy is not supported; use --extensible true');
      return 64;
    }
    targetExtensible = opts.strategy === 'sidecar_eav';
  } else {
    writeError('update table requires --extensible <true|false>');
    return 64;
  }

  // Resolve file path via IR (need owner from nodes map).
  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });
  const node = result.ir.nodes.get(opts.identity);
  if (node === undefined || node.kind !== 'table') {
    writeError(`table "${opts.identity}" not found`);
    return 64;
  }
  const filePath = identityToPath(opts.identity, node.owner, opts.path);
  if (filePath === undefined) {
    writeError(`cannot resolve identity "${opts.identity}" to a file path`);
    return 64;
  }

  // Read current state from the YAML file.
  const doc = await readYamlDoc(filePath);
  const root = doc.contents;
  if (!(root instanceof YAMLMap)) {
    writeError(`unexpected YAML structure in ${filePath}`);
    return 64;
  }

  // Determine current extensible state (new API takes precedence over legacy).
  const rawExtensible = root.get('extensible', true) as unknown;
  const currentExtensible =
    rawExtensible !== null && typeof rawExtensible === 'object' && 'toJSON' in rawExtensible
      ? (rawExtensible as { toJSON: () => unknown }).toJSON()
      : rawExtensible;
  const legacyExt = root.get('extension', true) as unknown;
  const isCurrentlyExtensible =
    currentExtensible === true ||
    (legacyExt instanceof YAMLMap &&
      String((legacyExt.get('strategy', true) as unknown) ?? 'none') === 'sidecar_eav');

  // ── Write-time constraint ──────────────────────────────────
  // If disabling extensions, check that no entity has ext fields.
  if (isCurrentlyExtensible && !targetExtensible) {
    let entityIdentity: string | undefined;
    for (const [eid, en] of result.ir.nodes) {
      if (en.kind !== 'entity') continue;
      const ed = en.data as { primary_table?: string };
      if (ed.primary_table === opts.identity) {
        entityIdentity = eid;
        break;
      }
    }
    if (entityIdentity !== undefined) {
      const extFields = result.ir.extensionFields.get(entityIdentity);
      if (extFields !== undefined && extFields.length > 0) {
        writeError(
          `cannot disable extensions: entity "${entityIdentity}" has ${extFields.length} extension field(s).\nremove them first: loom rm extension ${opts.path} --entity ${entityIdentity}`,
        );
        return 3;
      }
    }
  }

  // Apply the change: set top-level extensible flag.
  (root as YAMLMap).set('extensible' as never, targetExtensible as never);

  // Clean up legacy extension block if present (migrate to new form).
  if (legacyExt instanceof YAMLMap && targetExtensible) {
    // Preserve ext_table as default_ext_table during migration.
    const legacyExtTable = legacyExt.get('ext_table', true) as unknown;
    if (legacyExtTable !== undefined && root.get('default_ext_table', true) === undefined) {
      (root as YAMLMap).set(
        'default_ext_table' as never,
        String(legacyExtTable as object) as never,
      );
    }
    root.delete('extension');
  } else if (legacyExt instanceof YAMLMap && !targetExtensible) {
    root.delete('extension');
  }

  await writeYamlDoc(filePath, doc);
  writeText(`updated ${opts.identity}: extensible ${isCurrentlyExtensible} → ${targetExtensible}`);
  return 0;
}
