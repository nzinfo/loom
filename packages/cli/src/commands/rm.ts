/**
 * `loom rm <kind> <path> <identity>`
 *
 * Deletes a schema node file. Before deleting, checks the dependency graph
 * to ensure no other node references it — if it does, reports an error.
 */
import * as fs from 'node:fs/promises';
import { identityToPath } from '../shared/identity.js';
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
