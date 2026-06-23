/**
 * `loom add field <path> <target> <name> <type> [options]`
 * `loom rm field <path> <target> <name>`
 * `loom move field <path> <target> <field> <--after|--before|--first|--last>`
 * `loom order fields <path> <target> <field1> <field2> ...`
 *
 * Target is a node identity: table:..., type:..., or the file path itself.
 * For extensions, target is the file path (we don't resolve group identity
 * to a file without loading the IR).
 */
import process from 'node:process';
import { YAMLMap } from 'yaml';
import type { Owner } from '@loom/core';
import { extensionToPath, identityToPath } from '../shared/identity.js';
import { load } from '@loom/core';
import { NodeFileSystem } from '../shared/fs.js';
import { writeError, writeText } from '../shared/output.js';
import {
  createFieldNode,
  findField,
  getFieldsSeq,
  readYamlDoc,
  writeYamlDoc,
} from '../yaml/editor.js';

// ── add field ────────────────────────────────────────────────

export interface AddFieldOptions {
  readonly path: string;
  readonly target: string;
  readonly name: string;
  readonly type: string;
  readonly required?: boolean | undefined;
  readonly unique?: boolean | undefined;
  readonly column?: string | undefined;
  readonly args?: Record<string, unknown> | undefined;
}

export async function addFieldCommand(opts: AddFieldOptions): Promise<number> {
  const filePath = await resolveTargetFile(opts.path, opts.target);
  if (filePath === null) return 64;

  const doc = await readYamlDoc(filePath);
  const seq = getFieldsSeq(doc);
  if (seq === undefined) {
    writeError(`no fields array found in ${filePath}`);
    return 64;
  }

  // Check for duplicate.
  if (findField(seq, opts.name) !== undefined) {
    writeError(`field "${opts.name}" already exists in ${filePath}`);
    return 3;
  }

  // Parse type — could be "string" or "shop.core.Money" or "string max_length=255"
  const typeNode = parseTypeString(opts.type, opts.args);
  const fieldNode = createFieldNode(doc, opts.name, typeNode, {
    required: opts.required,
    unique: opts.unique,
    column: opts.column,
  });

  seq.add(fieldNode);
  await writeYamlDoc(filePath, doc);
  writeText(`added field "${opts.name}" to ${filePath}`);
  return 0;
}

// ── rm field ─────────────────────────────────────────────────

export interface RmFieldOptions {
  readonly path: string;
  readonly target: string;
  readonly name: string;
}

export async function rmFieldCommand(opts: RmFieldOptions): Promise<number> {
  const filePath = await resolveTargetFile(opts.path, opts.target);
  if (filePath === null) return 64;

  const doc = await readYamlDoc(filePath);
  const seq = getFieldsSeq(doc);
  if (seq === undefined) {
    writeError(`no fields array found in ${filePath}`);
    return 64;
  }

  const found = findField(seq, opts.name);
  if (found === undefined) {
    writeError(`field "${opts.name}" not found in ${filePath}`);
    return 3;
  }

  seq.delete(found.index);
  await writeYamlDoc(filePath, doc);
  writeText(`removed field "${opts.name}" from ${filePath}`);
  return 0;
}

// ── move field ───────────────────────────────────────────────

export interface MoveFieldOptions {
  readonly path: string;
  readonly target: string;
  readonly field: string;
  readonly after?: string | undefined;
  readonly before?: string | undefined;
  readonly first?: boolean | undefined;
  readonly last?: boolean | undefined;
}

export async function moveFieldCommand(opts: MoveFieldOptions): Promise<number> {
  const filePath = await resolveTargetFile(opts.path, opts.target);
  if (filePath === null) return 64;

  const doc = await readYamlDoc(filePath);
  const seq = getFieldsSeq(doc);
  if (seq === undefined) {
    writeError(`no fields array found in ${filePath}`);
    return 64;
  }

  const found = findField(seq, opts.field);
  if (found === undefined) {
    writeError(`field "${opts.field}" not found in ${filePath}`);
    return 3;
  }

  // Remove from current position.
  const node = seq.items[found.index]!;
  seq.delete(found.index);

  // Compute new position.
  let insertIndex: number;
  if (opts.first === true) {
    insertIndex = 0;
  } else if (opts.last === true) {
    insertIndex = seq.items.length;
  } else if (opts.after !== undefined) {
    const ref = findField(seq, opts.after);
    if (ref === undefined) {
      writeError(`reference field "${opts.after}" not found`);
      // Re-add at original position to undo the delete.
      seq.add(node);
      return 3;
    }
    insertIndex = ref.index + 1;
  } else if (opts.before !== undefined) {
    const ref = findField(seq, opts.before);
    if (ref === undefined) {
      writeError(`reference field "${opts.before}" not found`);
      seq.add(node);
      return 3;
    }
    insertIndex = ref.index;
  } else {
    writeError('move field requires --after, --before, --first, or --last');
    seq.add(node);
    return 64;
  }

  // Insert at new position.
  if (insertIndex >= seq.items.length) {
    seq.add(node);
  } else {
    seq.items.splice(insertIndex, 0, node);
  }

  await writeYamlDoc(filePath, doc);
  writeText(`moved field "${opts.field}" in ${filePath}`);
  return 0;
}

// ── order fields ─────────────────────────────────────────────

export interface OrderFieldsOptions {
  readonly path: string;
  readonly target: string;
  readonly order: readonly string[];
}

export async function orderFieldsCommand(opts: OrderFieldsOptions): Promise<number> {
  const filePath = await resolveTargetFile(opts.path, opts.target);
  if (filePath === null) return 64;

  const doc = await readYamlDoc(filePath);
  const seq = getFieldsSeq(doc);
  if (seq === undefined) {
    writeError(`no fields array found in ${filePath}`);
    return 64;
  }

  // Collect current field names.
  const currentNames: string[] = [];
  const nodeByName = new Map<string, unknown>();
  for (const item of seq.items) {
    if (!(item instanceof YAMLMap)) continue;
    const nameNode = item.get('name');
    if (nameNode !== undefined && nameNode !== null) {
      const name = String(nameNode);
      currentNames.push(name);
      nodeByName.set(name, item);
    }
  }

  // Validate: the new order must contain exactly the same fields.
  const orderSet = new Set(opts.order);
  const currentSet = new Set(currentNames);
  for (const name of currentNames) {
    if (!orderSet.has(name)) {
      writeError(`field "${name}" is missing from the new order (must list all fields)`);
      return 64;
    }
  }
  for (const name of opts.order) {
    if (!currentSet.has(name)) {
      writeError(`unknown field "${name}" in order (no such field in ${filePath})`);
      return 64;
    }
  }
  if (opts.order.length !== currentNames.length) {
    writeError(`order has ${opts.order.length} fields but file has ${currentNames.length}`);
    return 64;
  }

  // Reorder items.
  seq.items = opts.order
    .map((name) => nodeByName.get(name))
    .filter((n) => n !== undefined) as typeof seq.items;

  await writeYamlDoc(filePath, doc);
  writeText(`reordered fields in ${filePath}`);
  return 0;
}

// ── helpers ──────────────────────────────────────────────────

/**
 * Resolve a target to a file path.
 *
 * Accepted forms:
 *   - File path (contains / and ends with .yaml) — used directly
 *   - Node identity (type:..., table:..., entity:...) — resolved via IR
 *   - Extension target (extension:entity:...::group) — resolved via IR.extensionFields
 */
async function resolveTargetFile(basePath: string, target: string): Promise<string | null> {
  // If it looks like a file path, use directly.
  if (target.includes('/') && target.endsWith('.yaml')) {
    return target;
  }

  // Extension target: ext:<entity_identity>::<group_name>
  if (target.startsWith('ext:')) {
    const rest = target.slice('ext:'.length);
    const sep = rest.indexOf('::');
    if (sep < 0) {
      writeError(`extension target must be "ext:<entity>::<group>", got: ${target}`);
      return null;
    }
    const entityIdentity = rest.slice(0, sep);
    const groupName = rest.slice(sep + 2);

    const result = await load({ fs: new NodeFileSystem(), basePath });
    const ir = result.ir;

    // Find the owner from extensionFields registry.
    const entries = ir.extensionFields.get(entityIdentity);
    if (entries === undefined) {
      writeError(`no extension fields for entity "${entityIdentity}"`);
      return null;
    }
    const entry = entries.find((e) => e.group === groupName);
    if (entry === undefined) {
      writeError(`no extension group "${groupName}" on entity "${entityIdentity}"`);
      return null;
    }
    const owner: Owner = entry.owner;
    return extensionToPath(entityIdentity, groupName, owner, basePath);
  }

  // Node identity (type:..., table:..., entity:...)
  if (target.includes(':')) {
    const result = await load({ fs: new NodeFileSystem(), basePath });
    const ir = result.ir;

    const node = ir.nodes.get(target);
    const owner = node?.owner ?? { kind: 'platform' as const };
    const filePath = identityToPath(target, owner, basePath);
    if (filePath === undefined) {
      writeError(`cannot resolve identity "${target}" to a file path`);
      return null;
    }
    return filePath;
  }

  writeError(`target must be an identity (type:...), extension target (ext:...::...), or a .yaml file path, got: ${target}`);
  return null;
}

/**
 * Parse a type string like "string" or "shop.core.Money" into a
 * type descriptor. If args are provided, attach them.
 */
function parseTypeString(
  typeStr: string,
  args?: Record<string, unknown>,
): string | { ref: string; args?: Record<string, unknown> } {
  if (args && Object.keys(args).length > 0) {
    return { ref: typeStr, args };
  }
  return typeStr;
}
