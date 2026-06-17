/**
 * Sidecar EAV pivot view generator. See spec §7.4.
 *
 * For each sidecar_eav table whose entity has declared extension_fields,
 * produce a dialect-neutral PivotView describing:
 *   - the base + ext physical table names
 *   - one PivotColumn per declared extension field, with the EAV column
 *     (string_value / decimal_value / etc.) chosen by scalar type
 *   - multi-field value_type refs expanded into N columns using the same
 *     <prefix>_<subname> convention as the main table (spec §5.5)
 *
 * Dialect layers render PivotView into actual CREATE VIEW SQL.
 */
import type { IR } from '../ir/version.js';
import type { Entity } from '../ir/schemas.js';
import type {
  PhysicalModel,
} from './types.js';

/** Which ext-table value column holds a given scalar. Spec §7.3. */
const EAV_COLUMN_BY_SCALAR: Record<string, string> = {
  boolean: 'boolean_value',
  integer: 'int_value',
  bigint: 'int_value',
  decimal: 'decimal_value',
  string: 'string_value',
  text: 'string_value',
  datetime: 'datetime_value',
  date: 'datetime_value',
  uuid: 'string_value',
  bytes: 'json_value',
  json: 'json_value',
  enum: 'string_value',
};

export interface PivotColumn {
  /** Field name as declared in extension_fields (or expanded prefix_subname). */
  readonly fieldName: string;
  /** EAV physical column the value is stored in. */
  readonly eavColumn: string;
}

export interface PivotView {
  readonly viewName: string;
  readonly baseTable: string;
  readonly extTable: string;
  readonly baseColumns: readonly string[];
  readonly columns: readonly PivotColumn[];
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
      if (ptNode?.identity === `table:${table.name.replace(/_base$/, '')}` ||
          ptNode?.identity.endsWith(`.${table.name}`)) {
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
    const pivotCols: PivotColumn[] = [];
    if (extFields) {
      for (const ef of extFields) {
        if (ef.refValueTypeId) {
          // Multi/single-field value_type ref → expand into physical columns.
          const vtNode = ir.nodes.get(ef.refValueTypeId);
          if (vtNode?.kind !== 'value_type') continue;
          for (const f of vtNode.data.fields) {
            const fRec = f as Record<string, unknown>;
            const subScalar = typeof fRec.base === 'string' ? fRec.base : 'string';
            pivotCols.push({
              fieldName: `${ef.name}_${(f as { name: string }).name}`,
              eavColumn: EAV_COLUMN_BY_SCALAR[subScalar] ?? 'string_value',
            });
          }
        } else {
          pivotCols.push({
            fieldName: ef.name,
            eavColumn: EAV_COLUMN_BY_SCALAR[ef.scalar] ?? 'string_value',
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
    });
  }
  return out;
}
