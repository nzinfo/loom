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
import type { TypeDescriptor } from './schemas.js';

/** A parsed three-segment type reference. Single-segment names are NOT type
 *  refs (they are base_types short names); {@link parseTypeRef} returns null
 *  for them. */
export interface TypeRef {
  readonly system: string;
  readonly module: string;
  readonly name: string;
}

/**
 * Normalize a field's `type:` value (which may be a shorthand string or a
 * detailed {@link TypeDescriptor}) into the canonical descriptor form.
 *
 *   'integer'                       → { ref: 'integer', args: {}, meta: {} }
 *   { ref: 'string', args: {...} }  → as-is (with args/meta defaulted)
 *
 * Downstream passes (link, validate, expand) consume only the object form.
 */
export function normalizeType(t: string | TypeDescriptor): TypeDescriptor {
  if (typeof t === 'string') {
    return { ref: t };
  }
  return {
    ref: t.ref,
    ...(t.args && Object.keys(t.args).length > 0 ? { args: { ...t.args } } : {}),
    ...(t.meta && Object.keys(t.meta).length > 0 ? { meta: { ...t.meta } } : {}),
  };
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
 * Result of resolving a short name against the type namespace.
 *
 *   resolved   — matched exactly one type via using imports
 *   ambiguous  — multiple using imports matched; caller must emit a diagnostic
 *   unknown    — nothing matched; caller must emit a diagnostic
 *
 * Note: all types are equal — scalar/struct/enum differ only in projection
 * form, not in resolution. base.core's types are globally available because
 * base.core is the default using namespace, not because scalars are special.
 */
export type ResolutionResult =
  | { readonly kind: 'resolved'; readonly fqn: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'unknown' };

/**
 * Resolve a single-segment short name against the type namespace.
 *
 * @param shortName  the bare name (e.g. "integer", "Email", "Money")
 * @param using      the file's using list (wildcards `ns.*` and precise names
 *                   `ns.Name`). The default `base.core.*` is injected by the
 *                   caller before calling — all types in base.core (scalar AND
 *                   struct/enum) are globally available that way.
 * @param typeFqns   fully-qualified names of ALL type nodes in the IR
 *                   (scalar + struct + enum,不分 form)
 *
 * Resolution order (spec §4.6, unified):
 *   1. precise using entries (direct fqn match)
 *   2. wildcard using entries (ns.* → ns.shortName if it exists in typeFqns)
 *   3. ambiguity if >1 distinct fqn
 *   4. unknown
 */
export function resolveShortName(
  shortName: string,
  using: readonly string[],
  typeFqns: ReadonlySet<string>,
): ResolutionResult {
  // Collect candidate fqns from using entries.
  const candidates = new Set<string>();
  for (const entry of using) {
    if (entry.endsWith('.*')) {
      const ns = entry.slice(0, -2);
      const fqn = `${ns}.${shortName}`;
      if (typeFqns.has(fqn)) candidates.add(fqn);
    } else {
      // Precise name: matches only if its last segment equals shortName.
      const lastDot = entry.lastIndexOf('.');
      const lastName = lastDot < 0 ? entry : entry.slice(lastDot + 1);
      if (lastName === shortName && typeFqns.has(entry)) {
        candidates.add(entry);
      }
    }
  }

  if (candidates.size === 0) return { kind: 'unknown' };
  if (candidates.size === 1) {
    const fqn = [...candidates][0] as string;
    return { kind: 'resolved', fqn };
  }
  return { kind: 'ambiguous', candidates: [...candidates].sort() };
}
