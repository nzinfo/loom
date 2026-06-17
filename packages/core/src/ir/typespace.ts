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

/**
 * Result of resolving a short name against a candidate type namespace.
 *
 *   scalar     — matched a base_types scalar (default namespace, always wins)
 *   value_type — matched a value_type node via using imports
 *   ambiguous  — multiple using imports matched; caller must emit a diagnostic
 *   unknown    — nothing matched; caller must emit a diagnostic
 */
export type ResolutionResult =
  | { readonly kind: 'scalar'; readonly name: string }
  | { readonly kind: 'value_type'; readonly fqn: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'unknown' };

/**
 * Resolve a single-segment short name against the type namespace.
 *
 * @param shortName  the bare name (e.g. "integer", "Email")
 * @param using      the file's explicit using list (wildcards `ns.*` and
 *                   precise names `ns.Name`); default `base.core.*` is NOT
 *                   included here — the caller adds it for scalars only
 *                   (scalars are always available, value_types are not)
 * @param scalars    base_types scalar short-name set (the implicit namespace)
 * @param valueTypes fully-qualified value_type names available in the IR
 *
 * Resolution order (spec §4.6):
 *   1. scalar lookup (default namespace, always wins)
 *   2. precise using entries (direct fqn match)
 *   3. wildcard using entries (ns.* → ns.shortName if it exists in valueTypes)
 *   4. ambiguity if >1 distinct fqn across steps 2-3
 *   5. unknown
 */
export function resolveShortName(
  shortName: string,
  using: readonly string[],
  scalars: ReadonlySet<string>,
  valueTypes: ReadonlySet<string>,
): ResolutionResult {
  // Step 1: scalar default namespace.
  if (scalars.has(shortName)) {
    return { kind: 'scalar', name: shortName };
  }

  // Step 2-3: collect candidate fqns from using entries.
  const candidates = new Set<string>();
  for (const entry of using) {
    if (entry.endsWith('.*')) {
      const ns = entry.slice(0, -2);
      const fqn = `${ns}.${shortName}`;
      if (valueTypes.has(fqn)) candidates.add(fqn);
    } else {
      // Precise name: matches only if its last segment equals shortName.
      const lastDot = entry.lastIndexOf('.');
      const lastName = lastDot < 0 ? entry : entry.slice(lastDot + 1);
      if (lastName === shortName && valueTypes.has(entry)) {
        candidates.add(entry);
      }
    }
  }

  if (candidates.size === 0) return { kind: 'unknown' };
  if (candidates.size === 1) {
    const fqn = [...candidates][0] as string;
    return { kind: 'value_type', fqn };
  }
  return { kind: 'ambiguous', candidates: [...candidates].sort() };
}
