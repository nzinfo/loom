/**
 * `loom show entity <path> <name>` — inspect an entity's complete field set.
 * (Formerly `loom fields`.)
 *
 * `loom show type <path> <name>` — type details.
 * `loom show table <path> <name>` — table details.
 */
import { expandTables } from '@loom/core';
import type {
  ExtensionFieldEntry,
  IR,
  Owner,
  PhysicalColumn,
  PhysicalTable,
  TypeNode,
} from '@loom/core';
import type { GlobalFlags } from '../shared/flags.js';
import { loadOrError } from '../shared/load.js';
import { writeError, writeJson, writeText } from '../shared/output.js';

// ── show entity ──────────────────────────────────────────────

export interface ShowEntityOptions {
  readonly path: string;
  readonly entity: string;
  readonly flags: GlobalFlags;
}

export async function showEntityCommand(opts: ShowEntityOptions): Promise<number> {
  const { ir, code } = await loadOrError(opts.path);
  if (ir === undefined) return code;

  const entityId = opts.entity;
  const entityNode = ir.nodes.get(entityId);
  if (entityNode === undefined || entityNode.kind !== 'entity') {
    writeError(`entity "${entityId}" not found`);
    return 64;
  }

  const entityData = entityNode.data as { primary_table: string; name?: string };
  const tableId = entityData.primary_table;
  const tableNode = ir.nodes.get(tableId);
  if (tableNode === undefined || tableNode.kind !== 'table') {
    writeError(`primary_table "${tableId}" not found for entity "${entityId}"`);
    return 64;
  }

  const model = expandTables(ir);
  const tableData = tableNode.data as { table: { name: string } };
  const physTable = model.tables.find((t: PhysicalTable) => t.name === tableData.table.name);
  if (physTable === undefined) {
    writeError(`physical table "${tableData.table.name}" not found in model`);
    return 2;
  }

  // Build extension groups.
  const extFields = ir.extensionFields.get(entityId);
  const groups = buildGroups(extFields);

  if (opts.flags.json) {
    writeJson(serializeEntityView(entityId, physTable, groups, extFields, ir));
  } else {
    writeText(formatEntityView(entityId, physTable, groups, ir));
  }
  return 0;
}

// ── show type ────────────────────────────────────────────────

export interface ShowTypeOptions {
  readonly path: string;
  readonly identity: string;
  readonly flags: GlobalFlags;
}

export async function showTypeCommand(opts: ShowTypeOptions): Promise<number> {
  const { ir, code } = await loadOrError(opts.path);
  if (ir === undefined) return code;

  const node = ir.nodes.get(opts.identity);
  if (node === undefined || node.kind !== 'type') {
    writeError(`type "${opts.identity}" not found`);
    return 64;
  }

  const tn = node.data as TypeNode;
  if (opts.flags.json) {
    writeJson({
      identity: opts.identity,
      owner: formatOwner(node.owner),
      name: tn.name,
      form: tn.form,
      ...(tn.fields ? { fields: tn.fields } : {}),
      ...(tn.properties ? { properties: tn.properties } : {}),
      ...((tn as unknown as { variants?: unknown }).variants
        ? { variants: (tn as unknown as { variants?: unknown }).variants }
        : {}),
    });
  } else {
    writeText(formatType(opts.identity, node.owner, tn));
  }
  return 0;
}

// ── show table ───────────────────────────────────────────────

export interface ShowTableOptions {
  readonly path: string;
  readonly identity: string;
  readonly flags: GlobalFlags;
}

export async function showTableCommand(opts: ShowTableOptions): Promise<number> {
  const { ir, code } = await loadOrError(opts.path);
  if (ir === undefined) return code;

  const node = ir.nodes.get(opts.identity);
  if (node === undefined || node.kind !== 'table') {
    writeError(`table "${opts.identity}" not found`);
    return 64;
  }

  const model = expandTables(ir);
  const tableData = node.data as { table: { name: string } };
  const physTable = model.tables.find((t) => t.name === tableData.table.name);
  if (physTable === undefined) {
    writeError(`physical table "${tableData.table.name}" not found in model`);
    return 2;
  }

  if (opts.flags.json) {
    writeJson({
      identity: opts.identity,
      owner: formatOwner(node.owner),
      physicalTable: physTable,
    });
  } else {
    writeText(formatTable(opts.identity, node.owner, physTable));
  }
  return 0;
}

// ── show graph ───────────────────────────────────────────────

export interface ShowGraphOptions {
  readonly path: string;
  readonly flags: GlobalFlags;
}

export async function showGraphCommand(opts: ShowGraphOptions): Promise<number> {
  const { ir, code } = await loadOrError(opts.path);
  if (ir === undefined) return code;

  if (opts.flags.json) {
    const edges: { from: string; to: string }[] = [];
    for (const [from, deps] of ir.deps) {
      for (const to of deps) edges.push({ from, to });
    }
    writeJson({ nodes: [...ir.nodes.keys()], edges });
  } else {
    const lines: string[] = ['Dependency graph:', ''];
    for (const [from, deps] of ir.deps) {
      if (deps.size === 0) continue;
      lines.push(`  ${from}`);
      for (const to of deps) {
        lines.push(`    → ${to}`);
      }
    }
    writeText(lines.join('\n'));
  }
  return 0;
}

// ── formatting helpers ───────────────────────────────────────

interface GroupInfo {
  name: string;
  owner: string;
  fields: ExtensionFieldEntry[];
}

function buildGroups(extFields: readonly ExtensionFieldEntry[] | undefined): GroupInfo[] {
  if (!extFields || extFields.length === 0) return [];
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
  return groupOrder.map((name) => {
    const group = byGroup.get(name);
    const first = group?.[0];
    return {
      name,
      owner: first ? formatOwner(first.owner) : 'unknown',
      fields: group ?? [],
    };
  });
}

function formatEntityView(
  entityId: string,
  physTable: PhysicalTable,
  groups: GroupInfo[],
  ir: IR,
): string {
  const out: string[] = [];
  const entityName = entityId.slice('entity:'.length);
  out.push(`entity: ${entityName}`);
  out.push(`table: ${physTable.name}`);
  out.push('');

  out.push('── base fields ──────────────────────────');
  for (const col of physTable.columns) {
    out.push(`  ${pad(col.name)} ${formatScalar(col)}`);
  }
  out.push('');

  for (const group of groups) {
    out.push(`── group: ${group.name} (${group.owner}) ──────────────────────`);
    for (const ef of group.fields) {
      for (const line of formatExtField(ef, ir)) {
        out.push(`  ${line}`);
      }
    }
    out.push('');
  }

  return out.join('\n');
}

function serializeEntityView(
  entityId: string,
  physTable: PhysicalTable,
  groups: GroupInfo[],
  extFields: readonly ExtensionFieldEntry[] | undefined,
  ir: IR,
): unknown {
  return {
    entity: entityId,
    table: physTable.name,
    baseFields: physTable.columns.map((c) => ({
      name: c.name,
      scalar: c.scalar,
      required: c.required,
      unique: c.unique,
    })),
    groups: groups.map((g) => ({
      name: g.name,
      owner: g.owner,
      fields: g.fields.flatMap((ef) => formatExtFieldJson(ef, ir)),
    })),
  };
}

function formatType(identity: string, owner: Owner, tn: TypeNode): string {
  const out: string[] = [];
  out.push(`type: ${identity.slice('type:'.length)}`);
  out.push(`form: ${tn.form}`);
  out.push(`owner: ${formatOwner(owner)}`);
  out.push('');
  if (tn.form === 'scalar' && tn.properties) {
    out.push('properties:');
    for (const p of tn.properties) {
      const req = p.required ? ' (required)' : '';
      out.push(`  ${p.name}: ${p.type}${req}`);
    }
  }
  if (tn.fields) {
    out.push('fields:');
    for (const f of tn.fields) {
      out.push(`  ${formatFieldLine(f as Record<string, unknown>)}`);
    }
  }
  const variants = (tn as unknown as { variants?: ReadonlyArray<Record<string, unknown>> })
    .variants;
  if (variants) {
    out.push('variants:');
    for (const v of variants) {
      const val = v.value as string;
      const dn = v.display_name as string | undefined;
      out.push(`  ${val}${dn ? ` (${dn})` : ''}`);
    }
  }
  return out.join('\n');
}

function formatTable(identity: string, owner: Owner, physTable: PhysicalTable): string {
  const out: string[] = [];
  out.push(`table: ${identity.slice('table:'.length)}`);
  out.push(`owner: ${formatOwner(owner)}`);
  out.push(`qualified: ${physTable.qualifiedName}`);
  out.push('');
  out.push('columns:');
  for (const c of physTable.columns) {
    const flags: string[] = [];
    if (c.required) flags.push('NOT NULL');
    if (c.unique) flags.push('UNIQUE');
    out.push(
      `  ${pad(c.name)} ${formatScalar(c)}${flags.length > 0 ? `  ${flags.join(' ')}` : ''}`,
    );
  }
  out.push('');
  out.push(`primary key: ${physTable.primaryKey.join(', ')}`);
  if (physTable.indexes.length > 0) {
    out.push('');
    out.push('indexes:');
    for (const idx of physTable.indexes) {
      out.push(`  ${idx.name} (${idx.columns.join(', ')})${idx.unique ? ' UNIQUE' : ''}`);
    }
  }
  if (physTable.foreignKeys.length > 0) {
    out.push('');
    out.push('foreign keys:');
    for (const fk of physTable.foreignKeys) {
      out.push(
        `  ${fk.name}: ${fk.columns.join(', ')} → ${fk.refTable}(${fk.refColumns.join(', ')})${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ''}`,
      );
    }
  }
  return out.join('\n');
}

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

function formatScalar(col: PhysicalColumn): string {
  const props = col.props as Record<string, unknown>;
  return formatProps(col.scalar, props);
}

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

function formatExtField(ef: ExtensionFieldEntry, ir: IR): string[] {
  if (ef.refValueTypeId) {
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
  return [`${pad(ef.name)} ${formatProps(ef.scalar, ef.props)}`];
}

function formatExtFieldJson(ef: ExtensionFieldEntry, ir: IR): unknown[] {
  if (ef.refValueTypeId) {
    const vtNode = ir.nodes.get(ef.refValueTypeId);
    if (vtNode?.kind === 'type') {
      const fields = (vtNode.data as { fields?: ReadonlyArray<Record<string, unknown>> }).fields;
      if (fields && fields.length > 0) {
        return fields.map((f) => {
          const subName = f.name as string;
          const { scalar, props } = extractSub(f);
          return { name: `${ef.name}_${subName}`, scalar, props };
        });
      }
    }
  }
  return [{ name: ef.name, scalar: ef.scalar, props: ef.props }];
}

function formatSubType(f: Record<string, unknown>): string {
  const { scalar, props } = extractSub(f);
  return formatProps(scalar, props);
}

function extractSub(f: Record<string, unknown>): {
  scalar: string;
  props: Record<string, unknown>;
} {
  const rawType = f.type;
  if (typeof rawType === 'string') {
    const s = rawType.includes('.') ? rawType.slice(rawType.lastIndexOf('.') + 1) : rawType;
    return { scalar: s, props: {} };
  }
  if (typeof rawType === 'object' && rawType !== null) {
    const desc = rawType as { ref?: string; args?: Record<string, unknown> };
    const ref = desc.ref ?? '';
    const s = ref.includes('.') ? ref.slice(ref.lastIndexOf('.') + 1) : ref;
    return { scalar: s, props: desc.args ?? {} };
  }
  return { scalar: 'string', props: {} };
}

function formatFieldLine(f: Record<string, unknown>): string {
  const name = f.name as string;
  const flags: string[] = [];
  if (f.required) flags.push('required');
  if (f.unique) flags.push('unique');
  const { scalar, props } = extractSub(f);
  const typeStr = formatProps(scalar, props);
  return `${pad(name)} ${typeStr}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`;
}

function pad(name: string): string {
  const w = 24;
  return name.length >= w ? name : `${name}${' '.repeat(w - name.length)}`;
}
