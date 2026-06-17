/**
 * Type namespace — resolution of `type:` field values. See spec v2 §3, §7.2.
 *
 * v2 splits references into two namespaces:
 *   - identity refs:  `kind:sys.mod.Name`  (four-segment, kind required)
 *                     used by mixin include, primary_table, ref_table, entity
 *   - type refs:      `sys.mod.Name`        (three-segment, no kind)
 *                     used by field `type:`
 *
 * This module handles the *form* of type refs (single-segment vs
 * three-segment). Name *resolution* (looking up the node, checking kind,
 * disambiguating short names via `using`) lives in the loader's link pass
 * and operates on IR context — see Task 5.
 */

/** A parsed three-segment type reference. Single-segment names are NOT type
 *  refs (they are base_types short names); {@link parseTypeRef} returns null
 *  for them. */
export interface TypeRef {
  readonly system: string;
  readonly module: string;
  readonly name: string;
}

/**
 * Parse a `type:` value into a {@link TypeRef}.
 *
 * @returns structured ref for three-segment names; `null` for single-segment
 *          names (base_types short names — not a type ref) or any other form
 *          (the caller treats single-segment as base_types lookup and other
 *          forms as resolution errors).
 */
export function parseTypeRef(s: string): TypeRef | null {
  if (s === '') return null;
  const parts = s.split('.');
  if (parts.length !== 3) return null;
  const [system, module, name] = parts;
  if (system === undefined || module === undefined || name === undefined) return null;
  if (system === '' || module === '' || name === '') return null;
  return { system, module, name };
}
