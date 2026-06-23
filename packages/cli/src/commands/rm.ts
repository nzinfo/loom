/**
 * `loom rm <kind> <path> <identity>`
 * `loom rm extension <path> --entity <entity> [--group <group>]`
 *
 * Deletes a schema node file. For type/table/entity, checks the dependency
 * graph before deleting. For extension, deletes the .ext.yaml file directly.
 */
import * as fs from 'node:fs/promises';
import type { Owner } from '@loom/core';
import { extensionToPath, identityToPath } from '../shared/identity.js';
import { load } from '@loom/core';
import { NodeFileSystem } from '../shared/fs.js';
import { loadOrError } from '../shared/load.js';
import { writeError, writeText } from '../shared/output.js';

export interface RmNodeOptions {
  readonly path: string;
  readonly identity: string;
  readonly force: boolean;
}

export async function rmNodeCommand(opts: RmNodeOptions): Promise<number> {
  // Load IR to check dependencies.
  const { ir, code } = await loadOrError(opts.path);
  if (ir === undefined) return code;

  // Check if the node exists.
  const node = ir.nodes.get(opts.identity);
  if (node === undefined) {
    writeError(`node "${opts.identity}" not found`);
    return 64;
  }

  // Check dependencies — who references this node?
  const dependents: string[] = [];
  for (const [from, deps] of ir.deps) {
    if (deps.has(opts.identity)) {
      dependents.push(from);
    }
  }

  if (dependents.length > 0 && !opts.force) {
    writeError(
      `node "${opts.identity}" is referenced by ${dependents.length} other node(s):\n` +
        dependents.map((d) => `  ${d}`).join('\n') +
        '\nuse --force to delete anyway',
    );
    return 3;
  }

  // Resolve file path.
  const filePath = identityToPath(opts.identity, node.owner, opts.path);
  if (filePath === undefined) {
    writeError(`cannot resolve identity "${opts.identity}" to a file path`);
    return 64;
  }

  // Delete the file.
  try {
    await fs.unlink(filePath);
  } catch {
    writeError(`failed to delete file: ${filePath}`);
    return 3;
  }

  writeText(`deleted: ${filePath}`);
  if (dependents.length > 0) {
    writeText(
      `warning: ${dependents.length} node(s) still reference this (broken refs):\n` +
        dependents.map((d) => `  ${d}`).join('\n'),
    );
  }
  return 0;
}

export interface RmExtensionOptions {
  readonly path: string;
  readonly entity: string;
  readonly group: string | undefined;
  readonly force: boolean;
}

/**
 * Delete an extension_fields file.
 *
 * If --group is specified, deletes the .ext.yaml for that group only.
 * If --group is omitted, deletes ALL .ext.yaml files for the entity.
 */
export async function rmExtensionCommand(opts: RmExtensionOptions): Promise<number> {
  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });
  const ir = result.ir;

  const entries = ir.extensionFields.get(opts.entity);
  if (entries === undefined || entries.length === 0) {
    writeError(`no extension fields for entity "${opts.entity}"`);
    return 64;
  }

  // Collect (group, owner) pairs to delete.
  const toDelete: { group: string; owner: Owner }[] = [];
  if (opts.group !== undefined) {
    const entry = entries.find((e) => e.group === opts.group);
    if (entry === undefined) {
      writeError(`no extension group "${opts.group}" on entity "${opts.entity}"`);
      return 64;
    }
    toDelete.push({ group: entry.group, owner: entry.owner });
  } else {
    // Delete all groups — collect unique (group, owner) pairs.
    const seen = new Set<string>();
    for (const e of entries) {
      const key = `${e.group}::${e.owner.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        toDelete.push({ group: e.group, owner: e.owner });
      }
    }
  }

  let deleted = 0;
  for (const { group, owner } of toDelete) {
    const filePath = extensionToPath(opts.entity, group, owner, opts.path);
    try {
      await fs.unlink(filePath);
      deleted++;
    } catch {
      writeError(`failed to delete: ${filePath}`);
    }
  }

  if (deleted > 0) {
    writeText(`deleted ${deleted} extension file(s) for entity "${opts.entity}"`);
  }
  return deleted > 0 ? 0 : 3;
}
