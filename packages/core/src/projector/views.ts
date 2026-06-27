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
import type { ExtensionFieldEntry, PhysicalModel, PhysicalTable } from './types.js';

/** A LEFT JOIN on the ext table for one extension group. */
export interface GroupJoin {
  /** Group name (for debugging/display). */
  readonly group: string;
  /** SQL alias for this join (e.g. 'p', 'f', 'e0'). */
  readonly alias: string;
  /** xxHash64 source hash (16-char hex) — identifies rows in the shared ext table. */
  readonly sourceHash: string;
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
  /** Base table's primary key column names (for JOIN condition generation). */
  readonly basePkColumns: readonly string[];
  readonly columns: readonly PivotColumn[];
  readonly groupJoins: readonly GroupJoin[];
}

export function buildPivotViews(model: PhysicalModel, ir: IR): PivotView[] {
  const out: PivotView[] = [];

  // Build primary_table identity → PhysicalTable lookup.
  // The sidecar ext table name lives on the base PhysicalTable (extTableName),
  // and the view name comes from the entity. We iterate entities (not sidecar
  // tables) so each entity's ext fields attach to the right view — critical
  // when multiple entities share one sidecar table.
  const tableByIdentity = new Map<string, PhysicalTable>();
  for (const t of model.tables) {
    if (t.strategy === 'none' || t.strategy === 'new_table') continue;
    // The PhysicalTable doesn't carry its own IR identity, but the base table's
    // identity is recoverable: the table IR node identities are in ir.nodes.
    // Match by qualifiedName suffix against table identity.
  }
  // Index base tables by their identity for O(1) entity→table lookup.
  // The identity→table map: walk ir.nodes for tables, match to model.tables
  // by comparing schema.name against the table IR node's derived physical name.
  const baseTableByIdentity = new Map<string, PhysicalTable>();
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'table') continue;
    const t = node.data as { table: { name: string } };
    const match = model.tables.find(
      (mt) => mt.name === t.table.name && mt.strategy !== 'new_table',
    );
    if (match) baseTableByIdentity.set(identity, match);
  }

  for (const [entityId, node] of ir.nodes) {
    if (node.kind !== 'entity') continue;
    const e = node.data as Entity;
    const baseTable = baseTableByIdentity.get(e.primary_table);
    if (!baseTable) continue;
    // Only base tables with a sidecar strategy + declared view produce a view.
    if (
      (baseTable.strategy !== 'sidecar_eav' && baseTable.strategy !== 'sidecar_jsonb') ||
      !baseTable.extTableName ||
      !baseTable.viewName
    )
      continue;

    const extFields = model.extensionFields.get(entityId);
    // Only sidecar exts participate in pivot views — new_table exts have their
    // own physical tables and should not be pivoted from JSONB.
    const sidecarFields = extFields?.filter(
      (ef) => ef.strategy === 'sidecar_jsonb' || ef.strategy === undefined,
    );
    if (!sidecarFields || sidecarFields.length === 0) {
      // Entity has a sidecar'd base table but no ext fields of its own.
      // Skip emitting a view (the table is shared; another entity owns the ext).
      continue;
    }

    // Assign SQL aliases to each group ('u' is reserved for the base table).
    const usedAliases = new Set<string>(['u']);
    const groupJoins: GroupJoin[] = [];
    const groupToAlias = new Map<string, string>();
    for (const ef of sidecarFields) {
      if (!groupToAlias.has(ef.group)) {
        const alias = pickGroupAlias(ef.group, usedAliases);
        groupToAlias.set(ef.group, alias);
        groupJoins.push({
          group: ef.group,
          alias,
          sourceHash: ef.sourceHash ?? ef.group, // fallback to group name if no hash
        });
      }
    }

    // Build pivot columns. Multi-field struct refs expand into N columns,
    // each in the same group as their parent field.
    const pivotCols: PivotColumn[] = [];
    for (const ef of sidecarFields) {
      const gAlias = groupToAlias.get(ef.group);
      if (gAlias === undefined) continue;

      if (ef.refValueTypeId) {
        // Multi/single-field struct ref → expand into JSON keys.
        const vtNode = ir.nodes.get(ef.refValueTypeId);
        if (vtNode?.kind !== 'type') continue;
        const vtFields = (vtNode.data as { fields?: ReadonlyArray<{ name: string }> }).fields ?? [];
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

    out.push({
      viewName: baseTable.viewName,
      baseTable: baseTable.qualifiedName,
      extTable: baseTable.extTableName,
      baseColumns: baseTable.columns.map((c) => c.name),
      basePkColumns: baseTable.primaryKey,
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
