/**
 * Field expansion logic. See spec §5.5, §6.7.
 *
 * Single rule: when a table/entity field references a value_type,
 * - 1 field named "value"  → 1 column, no suffix (newtype pass-through)
 * - N fields (or 1 field not named "value") → N columns, named <prefix>_<field>
 *
 * The same rule applies to extension_fields. Pure logic; no I/O.
 *
 * Naming note: this module exports `ExpandedColumn` (name-only) to avoid
 * colliding with `PhysicalColumn` in `projector/types.ts` (which carries
 * full type info). Both are re-exported through `index.ts`.
 */

/** Loose view of a value_type node — only what expansion needs. */
export interface ValueTypeNode {
  readonly kind: 'value_type';
  readonly name: string;
  readonly fields: ReadonlyArray<{ readonly name: string }>;
}

/** A column name produced by value_type expansion. */
export interface ExpandedColumn {
  readonly name: string;
}

/** True iff the value_type is a single-field newtype (field name === 'value'). */
export function isSingleFieldValueType(vt: ValueTypeNode): boolean {
  return vt.fields.length === 1 && vt.fields[0]?.name === 'value';
}

/**
 * Expand a value_type reference into physical column names.
 * @param prefix the table/entity field name that references the value_type.
 */
export function expandValueColumns(prefix: string, vt: ValueTypeNode): ExpandedColumn[] {
  if (isSingleFieldValueType(vt)) {
    return [{ name: prefix }];
  }
  return vt.fields.map((f) => ({ name: `${prefix}_${f.name}` }));
}
