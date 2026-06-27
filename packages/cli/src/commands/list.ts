/**
 * `loom list <kind> <path>` — list all nodes of a given kind.
 *
 * Kinds: types, tables, entities, extensions.
 */
import type { IRNode, Owner } from '@loom/core';
import type { GlobalFlags } from '../shared/flags.js';
import { loadOrError } from '../shared/load.js';
import { writeError, writeJson, writeText } from '../shared/output.js';

export interface ListOptions {
  readonly path: string;
  readonly flags: GlobalFlags;
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

type ListEntry = {
  identity: string;
  owner: string;
  name: string;
  detail?: Record<string, unknown>;
};

function collectNodes(
  ir: { nodes: ReadonlyMap<string, IRNode> },
  kind: 'type' | 'table' | 'entity',
): ListEntry[] {
  const out: ListEntry[] = [];
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== kind) continue;
    const data = node.data as Record<string, unknown>;
    const entry: ListEntry = {
      identity,
      owner: formatOwner(node.owner),
      name: data.name as string,
    };
    if (kind === 'type') {
      entry.detail = { form: data.form };
    } else if (kind === 'entity') {
      entry.detail = {
        primary_table: data.primary_table,
        ...(data.business_keys ? { business_keys: data.business_keys } : {}),
      };
    } else if (kind === 'table') {
      const table = data.table as Record<string, unknown>;
      const extensible = data.extensible === true;
      const legacyStrategy = (data.extension as Record<string, unknown>)?.strategy ?? 'none';
      entry.detail = {
        physical_name: table.name,
        extensible,
        strategy: extensible ? 'sidecar_jsonb' : legacyStrategy,
      };
    }
    out.push(entry);
  }
  return out;
}

function collectExtensions(ir: {
  extensionFields: ReadonlyMap<string, readonly { group: string; owner: Owner }[]>;
}): ListEntry[] {
  const out: ListEntry[] = [];
  for (const [entity, entries] of ir.extensionFields) {
    const groups = new Map<string, string>();
    for (const ef of entries) {
      if (!groups.has(ef.group)) {
        groups.set(ef.group, formatOwner(ef.owner));
      }
    }
    for (const [groupName, owner] of groups) {
      out.push({
        identity: `extension:${entity}::${groupName}`,
        owner,
        name: groupName,
        detail: { entity },
      });
    }
  }
  return out;
}

export async function listCommand(
  kind: 'types' | 'tables' | 'entities' | 'extensions',
  opts: ListOptions,
): Promise<number> {
  const { ir, code } = await loadOrError(opts.path);
  if (ir === undefined) return code;

  let entries: ListEntry[];
  switch (kind) {
    case 'types':
      entries = collectNodes(ir, 'type');
      break;
    case 'tables':
      entries = collectNodes(ir, 'table');
      break;
    case 'entities':
      entries = collectNodes(ir, 'entity');
      break;
    case 'extensions':
      entries = collectExtensions(ir);
      break;
  }

  if (opts.flags.json) {
    writeJson(entries);
  } else {
    if (entries.length === 0) {
      writeText(`(no ${kind} found)`);
      return 0;
    }
    const lines = entries.map((e) => {
      const detailStr = e.detail ? ` ${JSON.stringify(e.detail)}` : '';
      return `  ${pad(e.identity)} [${e.owner}]${detailStr}`;
    });
    writeText(`${kind} (${entries.length}):\n${lines.join('\n')}`);
  }
  return 0;
}

function pad(s: string): string {
  const w = 40;
  return s.length >= w ? s : `${s}${' '.repeat(w - s.length)}`;
}
