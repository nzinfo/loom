/**
 * Sidecar JSONB pivot view generator. See
 * `docs/design/2026-06-22-jsonb-extension-groups.md`.
 *
 * For each sidecar_eav table whose entity has declared extension_fields,
 * produce a dialect-neutral PivotView describing:
 *   - the base + ext physical table names
 *   - one GroupJoin per distinct extension group (each group becomes one
 *     LEFT JOIN on the ext table, filtered by group_name)
 *   - one PivotColumn per declared extension field (multi-field struct refs
 *     expand into N columns using the same <prefix>_<subname> convention
 *     as the main table), each tagged with its group's join alias
 *
 * Dialect layers render PivotView into CREATE VIEW SQL with LEFT JOIN +
 * JSON extraction (pg/mysql: `->>`, sqlite: `json_extract`).
 */
import type { Entity } from '../ir/schemas.js';
import type { IR } from '../ir/version.js';
import type { ExtensionFieldEntry, PhysicalModel } from './types.js';

/** A LEFT JOIN on the ext table for one extension group. */
export interface GroupJoin {
  /** Group name (matches ext table's group_name column). */
  readonly group: string;
  /** SQL alias for this join (e.g. 'p', 'f', 'e0'). */
  readonly alias: string;
}

/** A pivot column: one JSON key extracted from a group's values. */
export interface PivotColumn {
  /** JSON key in the group's values document (or expanded prefix_subname). */
  readonly fieldName: string;
  /** Alias of the GroupJoin whose values document holds this key. */
  readonly groupAlias: string;
}

export interface PivotView {
  readonly viewName: string;
  readonly baseTable: string;
  readonly extTable: string;
  readonly baseColumns: readonly string[];
  readonly columns: readonly PivotColumn[];
  readonly groupJoins: readonly GroupJoin[];
}

export function buildPivotViews(model: PhysicalModel, ir: IR): PivotView[] {
  const out: PivotView[] = [];
  // entity identity → primary_table identity
  const entityToTable = new Map<string, string>();
  for (const node of ir.nodes.values()) {
    if (node.kind !== 'entity') continue;
    const e = node.data as Entity;
    entityToTable.set(node.identity, e.primary_table);
  }

  for (const table of model.tables) {
    if (table.strategy !== 'sidecar_eav' || !table.extTableName || !table.viewName) continue;

    // Find the entity whose primary_table points at this table.
    let entityId: string | undefined;
    for (const [eid, ptId] of entityToTable) {
      const ptNode = ir.nodes.get(ptId);
      if (
        ptNode?.identity === `table:${table.name.replace(/_base$/, '')}` ||
        ptNode?.identity.endsWith(`.${table.name}`)
      ) {
        entityId = eid;
        break;
      }
    }
    // Fallback: match by the table's own identity suffix.
    if (entityId === undefined) {
      for (const [eid] of entityToTable) {
        const ext = model.extensionFields.get(eid);
        if (ext !== undefined) {
          entityId = eid;
          break;
        }
      }
    }

    const extFields = entityId !== undefined ? model.extensionFields.get(entityId) : undefined;

    // Assign SQL aliases to each group ('u' is reserved for the base table).
    const usedAliases = new Set<string>(['u']);
    const groupJoins: GroupJoin[] = [];
    const groupToAlias = new Map<string, string>();
    if (extFields) {
      for (const ef of extFields) {
        if (!groupToAlias.has(ef.group)) {
          const alias = pickGroupAlias(ef.group, usedAliases);
          groupToAlias.set(ef.group, alias);
          groupJoins.push({ group: ef.group, alias });
        }
      }
    }

    // Build pivot columns. Multi-field struct refs expand into N columns,
    // each in the same group as their parent field.
    const pivotCols: PivotColumn[] = [];
    if (extFields) {
      for (const ef of extFields) {
        const gAlias = groupToAlias.get(ef.group);
        if (gAlias === undefined) continue;

        if (ef.refValueTypeId) {
          // Multi/single-field struct ref → expand into JSON keys.
          const vtNode = ir.nodes.get(ef.refValueTypeId);
          if (vtNode?.kind !== 'type') continue;
          const vtFields =
            (vtNode.data as { fields?: ReadonlyArray<{ name: string }> }).fields ?? [];
          for (const f of vtFields) {
            pivotCols.push({
              fieldName: `${ef.name}_${f.name}`,
              groupAlias: gAlias,
            });
          }
        } else {
          pivotCols.push({
            fieldName: ef.name,
            groupAlias: gAlias,
          });
        }
      }
    }

    out.push({
      viewName: table.viewName,
      baseTable: table.qualifiedName,
      extTable: table.extTableName,
      baseColumns: table.columns.map((c) => c.name),
      columns: pivotCols,
      groupJoins,
    });
  }
  return out;
}

/**
 * Pick a short SQL alias for a group. Prefers the first character of the
 * group name (lowercased) when available; falls back to e0, e1, ... to
 * avoid collisions (including with the base table alias 'u').
 */
function pickGroupAlias(group: string, used: Set<string>): string {
  const first = group.charAt(0).toLowerCase();
  if (/[a-z]/.test(first) && !used.has(first)) {
    used.add(first);
    return first;
  }
  let i = 0;
  while (used.has(`e${i}`)) i++;
  const alias = `e${i}`;
  used.add(alias);
  return alias;
}
