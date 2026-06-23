/**
 * `loom update table <path> <identity> --strategy <strategy>`
 *
 * Modifies table properties. Currently supports changing extension strategy.
 *
 * Write-time constraint enforcement:
 *   Changing strategy FROM sidecar_eav TO none/json_column is blocked if the
 *   table's entity has declared extension_fields — the ext data has nowhere
 *   to go. The user must remove the extension fields first (rm extension).
 */
import { load } from '@loom/core';
import { NodeFileSystem } from '../shared/fs.js';
import { identityToPath } from '../shared/identity.js';
import { readYamlDoc, writeYamlDoc } from '../yaml/editor.js';
import { writeError, writeText } from '../shared/output.js';
import { YAMLMap } from 'yaml';

export interface UpdateTableOptions {
  readonly path: string;
  readonly identity: string;
  readonly strategy: string | undefined;
}

export async function updateTableCommand(opts: UpdateTableOptions): Promise<number> {
  if (opts.strategy === undefined) {
    writeError('update table requires --strategy <none|sidecar_eav|json_column>');
    return 64;
  }
  if (!['none', 'sidecar_eav', 'json_column'].includes(opts.strategy)) {
    writeError(`strategy must be none|sidecar_eav|json_column, got "${opts.strategy}"`);
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

  // Read current strategy from the YAML file.
  const doc = await readYamlDoc(filePath);
  const root = doc.contents;
  if (!(root instanceof YAMLMap)) {
    writeError(`unexpected YAML structure in ${filePath}`);
    return 64;
  }
  const tableNode = root.get('table', true);
  if (!(tableNode instanceof YAMLMap)) {
    writeError(`no table block in ${filePath}`);
    return 64;
  }
  const extNode = tableNode.get('extension', true);
  if (!(extNode instanceof YAMLMap)) {
    writeError(`no extension block in ${filePath}`);
    return 64;
  }
  const strategyNode = extNode.get('strategy', true);
  const currentStrategy = strategyNode ? String(strategyNode.toJSON()) : 'none';

  // ── Write-time constraint ──────────────────────────────────
  // If changing FROM sidecar_eav, check that no entity has ext fields
  // pointing at this table.
  if (currentStrategy === 'sidecar_eav' && opts.strategy !== 'sidecar_eav') {
    // Find the entity whose primary_table is this table.
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
          `cannot change strategy from sidecar_eav to ${opts.strategy}: ` +
            `entity "${entityIdentity}" has ${extFields.length} extension field(s).\n` +
            `remove them first: loom rm extension ${opts.path} --entity ${entityIdentity}`,
        );
        return 3;
      }
    }
  }

  // Apply the change.
  extNode.set('strategy', opts.strategy);

  // If switching to none, remove ext_table (no longer needed).
  if (opts.strategy === 'none') {
    extNode.delete('ext_table');
    // If extension block is now just {strategy: none}, keep it minimal.
  }

  await writeYamlDoc(filePath, doc);
  writeText(`updated ${opts.identity}: strategy ${currentStrategy} → ${opts.strategy}`);
  return 0;
}
