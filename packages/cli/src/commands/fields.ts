/** `loom fields <path> <entity>` — inspect an entity's complete field set. */
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import process from 'node:process';
import { type FileSystem, expandTables, load } from '@loom/core';
import type { ExtensionFieldEntry, IR, Owner, PhysicalColumn, PhysicalTable } from '@loom/core';

class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array> {
    return fs.readFile(path);
  }
  async *listFiles(dir: string): AsyncIterable<string> {
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = `${current}/${entry.name}`;
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')))
          yield full;
      }
    }
  }
  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const s = await fs.stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  }
}

export interface FieldsOptions {
  readonly path: string;
  readonly entity: string;
}

export async function fieldsCommand(opts: FieldsOptions): Promise<number> {
  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });
  if (result.diagnostics.hasErrors) {
    process.stderr.write(result.diagnostics.format());
    process.stderr.write('\n');
    return 1;
  }

  const { ir } = result;
  const entityId = opts.entity;

  // Look up the entity node.
  const entityNode = ir.nodes.get(entityId);
  if (entityNode === undefined || entityNode.kind !== 'entity') {
    process.stderr.write(`error: entity "${entityId}" not found\n`);
    return 64;
  }

  const entityData = entityNode.data as { primary_table: string; name?: string };
  const tableId = entityData.primary_table;
  const tableNode = ir.nodes.get(tableId);
  if (tableNode === undefined || tableNode.kind !== 'table') {
    process.stderr.write(`error: primary_table "${tableId}" not found for entity "${entityId}"\n`);
    return 64;
  }

  // Expand the physical model to get base columns.
  const model = expandTables(ir);
  const tableData = tableNode.data as { table: { name: string } };
  const physTable = model.tables.find((t: PhysicalTable) => t.name === tableData.table.name);
  if (physTable === undefined) {
    process.stderr.write(`error: physical table "${tableData.table.name}" not found in model\n`);
    return 2;
  }

  // ── Output ──
  const out: string[] = [];
  const entityName = entityId.slice('entity:'.length);
  out.push(`entity: ${entityName}`);
  out.push(`table: ${physTable.name}`);
  out.push('');

  // Base fields
  out.push('── base fields ──────────────────────────');
  for (const col of physTable.columns) {
    out.push(`  ${pad(col.name)} ${formatScalar(col)}`);
  }
  out.push('');

  // Extension fields, grouped by group
  const extFields = ir.extensionFields.get(entityId);
  if (extFields !== undefined && extFields.length > 0) {
    // Group entries preserving first-seen order.
    const groupOrder: string[] = [];
    const byGroup = new Map<string, ExtensionFieldEntry[]>();
    for (const ef of extFields) {
      let bucket = byGroup.get(ef.group);
      if (bucket === undefined) {
        bucket = [];
        byGroup.set(ef.group, bucket);
        groupOrder.push(ef.group);
      }
      bucket.push(ef);
    }

    for (const group of groupOrder) {
      const entries = byGroup.get(group);
      if (entries === undefined) continue;
      const ownerStr = entries[0] ? formatOwner(entries[0].owner) : 'unknown';
      out.push(`── group: ${group} (${ownerStr}) ──────────────────────`);
      for (const ef of entries) {
        for (const line of formatExtField(ef, ir)) {
          out.push(`  ${line}`);
        }
      }
      out.push('');
    }
  }

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

/** Format an Owner into a human-readable source string. */
function formatOwner(owner: Owner): string {
  switch (owner.kind) {
    case 'platform':
      return 'platform';
    case 'ext':
      return `ext:${owner.provider}`;
    case 'tenant':
      return `tenant:${owner.id}`;
  }
}

/** Format a physical column's type string. */
function formatScalar(col: PhysicalColumn): string {
  const props = col.props as Record<string, unknown>;
  switch (col.scalar) {
    case 'string':
      return `string(${props.max_length ?? 255})`;
    case 'decimal':
      return `decimal(${props.precision ?? 18},${props.scale ?? 4})`;
    default:
      return col.scalar;
  }
}

/** Format an extension field entry, expanding struct refs into sub-fields. */
function formatExtField(ef: ExtensionFieldEntry, ir: IR): string[] {
  if (ef.refValueTypeId) {
    // Struct/enum ref — expand sub-fields.
    const vtNode = ir.nodes.get(ef.refValueTypeId);
    if (vtNode?.kind === 'type') {
      const fields = (vtNode.data as { fields?: ReadonlyArray<Record<string, unknown>> }).fields;
      if (fields && fields.length > 0) {
        return fields.map((f) => {
          const subName = f.name as string;
          const subType = formatSubType(f);
          return `${pad(`${ef.name}_${subName}`)} ${subType}`;
        });
      }
    }
    return [`${pad(ef.name)} (unresolved ref: ${ef.refValueTypeId})`];
  }
  // Scalar field
  return [`${pad(ef.name)} ${formatProps(ef.scalar, ef.props)}`];
}

/** Format a sub-field's type from a struct definition. */
function formatSubType(f: Record<string, unknown>): string {
  const rawType = f.type;
  let ref = '';
  let props: Record<string, unknown> = {};
  if (typeof rawType === 'string') {
    ref = rawType;
  } else if (typeof rawType === 'object' && rawType !== null) {
    const desc = rawType as { ref?: string; args?: Record<string, unknown> };
    ref = desc.ref ?? '';
    props = desc.args ?? {};
  }
  // ref may be an fqn after link resolution; use last segment as scalar name.
  const scalar = ref.includes('.') ? ref.slice(ref.lastIndexOf('.') + 1) : ref;
  return formatProps(scalar, props);
}

/** Format scalar name with its properties (max_length, precision, scale). */
function formatProps(scalar: string, props: Readonly<Record<string, unknown>>): string {
  switch (scalar) {
    case 'string':
      return `string(${props.max_length ?? 255})`;
    case 'decimal':
      return `decimal(${props.precision ?? 18},${props.scale ?? 4})`;
    default:
      return scalar;
  }
}

/** Pad a field name to a fixed column width for alignment. */
function pad(name: string): string {
  const w = 24;
  return name.length >= w ? name : `${name}${' '.repeat(w - name.length)}`;
}
