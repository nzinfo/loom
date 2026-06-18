import type { Diagnostics } from '../errors.js';
import { parseRef } from '../ir/refs.js';
import type { AnyFile, BaseTypes, TypeDescriptor } from '../ir/schemas.js';
import { type TypeRef, normalizeType, parseTypeRef, resolveShortName } from '../ir/typespace.js';
import type { ExtensionFieldEntry, IR, IRNode, Identity, Owner } from '../ir/version.js';
import type { FileKind } from '../ir/version.js';
import { CURRENT_VERSION } from '../ir/version.js';

/**
 * Default owner when discovery metadata is unavailable (stub until the link
 * pass receives the discovery `files` map in a follow-up commit). Real owner
 * is derived from the directory path; this placeholder keeps the type system
 * green in the interim.
 */
const DEFAULT_OWNER: Owner = { kind: 'platform' };

/**
 * Pass 2 — link. See spec §13.1, §12.
 *
 * For every parsed file:
 *   - resolves $refs against the parsed map (dangling_ref / kind_mismatch)
 *   - expands mixin includes in-place (recursive, with cycle detection)
 *   - records dependency edges into the IR's dep graph
 *
 * Output: an immutable IR with fully resolved nodes.
 */
export interface LinkOptions {
  readonly parsed: ReadonlyMap<string, AnyFile>;
  readonly diagnostics: Diagnostics;
}

export interface LinkResult {
  readonly ir: IR;
  readonly diagnostics: Diagnostics;
}

/** Ref kinds legal as a mixin include target. */
const INCLUDE_REF_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['mixin']);

export async function link(opts: LinkOptions): Promise<LinkResult> {
  const nodes = new Map<Identity, IRNode>();
  const deps = new Map<Identity, Set<Identity>>();

  // Lift all parsed files into IRNodes keyed by identity.
  // Owner is stubbed to DEFAULT_OWNER here; a follow-up commit wires real
  // owner from the discovery `files` map (derived from directory path).
  for (const [identity, file] of opts.parsed) {
    nodes.set(identity, { ...file, identity, owner: DEFAULT_OWNER });
    deps.set(identity, new Set());
  }

  // Collect candidate sets for type resolution.
  const scalars = collectScalars(opts.parsed);
  const valueTypes = collectValueTypeFqns(opts.parsed);

  // Resolve type refs + expand mixins per file.
  for (const [identity, node] of nodes) {
    const fieldsHost = fieldsOf(node);
    if (fieldsHost === null) continue;

    const expanded = expandIncludes(fieldsHost, identity, opts.parsed, opts.diagnostics, deps);
    if (expanded === null) continue;

    const fileUsing = collectUsing(node);
    const typeParams = collectTypeParameters(node);
    resolveFieldTypes(
      expanded,
      identity,
      fileUsing,
      scalars,
      valueTypes,
      typeParams,
      opts.parsed,
      opts.diagnostics,
      deps,
    );

    nodes.set(identity, withFields(node, expanded));
  }

  const ir: IR = {
    nodes: nodes as ReadonlyMap<Identity, IRNode>,
    deps: deps as ReadonlyMap<Identity, ReadonlySet<Identity>>,
    version: CURRENT_VERSION,
    // Stub: empty until the link pass aggregates extension_fields from the
    // parsed set in a follow-up commit.
    extensionFields: new Map<Identity, ReadonlyArray<ExtensionFieldEntry>>(),
  };
  return { ir, diagnostics: opts.diagnostics };
}

// ---- helpers ----

interface FieldsHost {
  fields: unknown[];
}

function fieldsOf(node: IRNode): FieldsHost | null {
  const data = node.data as { fields?: unknown[] };
  if (Array.isArray(data.fields)) return data as FieldsHost;
  return null;
}

function withFields(node: IRNode, fields: FieldsHost): IRNode {
  const updated = { ...node, data: { ...(node.data as object), fields: fields.fields } };
  return updated as IRNode;
}

/** Collect base_types scalar short names from the parsed set. */
function collectScalars(parsed: ReadonlyMap<string, AnyFile>): Set<string> {
  const scalars = new Set<string>();
  for (const f of parsed.values()) {
    if (f.kind !== 'base_types') continue;
    const data = f.data as BaseTypes;
    for (const s of data.scalars) scalars.add(s.name);
  }
  return scalars;
}

/** Collect value_type fully-qualified names (sys.mod.Name) from the parsed set. */
function collectValueTypeFqns(parsed: ReadonlyMap<string, AnyFile>): Set<string> {
  const fqns = new Set<string>();
  for (const [identity, f] of parsed) {
    if (f.kind !== 'value_type') continue;
    // Identity format: value_type:sys.mod.Name
    const colonIdx = identity.indexOf(':');
    if (colonIdx < 0) continue;
    fqns.add(identity.slice(colonIdx + 1));
  }
  return fqns;
}

/** Read the file's optional using list (empty if absent). */
function collectUsing(node: IRNode): readonly string[] {
  const data = node.data as { using?: unknown };
  if (Array.isArray(data.using))
    return data.using.filter((s): s is string => typeof s === 'string');
  return [];
}

/** Read the value_type's optional type_parameters names (empty if absent). */
function collectTypeParameters(node: IRNode): ReadonlySet<string> {
  const data = node.data as { type_parameters?: Array<{ name: string }> };
  if (!Array.isArray(data.type_parameters)) return new Set();
  return new Set(data.type_parameters.map((p) => p.name));
}

interface IncludeEntry {
  readonly include: string;
}

function isInclude(x: unknown): x is IncludeEntry {
  return typeof x === 'object' && x !== null && 'include' in x && !('base' in x) && !('ref' in x);
}

/**
 * Expand mixin includes in place. Returns the mutated host or null if a
 * fatal cycle aborted expansion for this node.
 */
function expandIncludes(
  host: FieldsHost,
  identity: Identity,
  parsed: ReadonlyMap<string, AnyFile>,
  diag: Diagnostics,
  deps: Map<Identity, Set<Identity>>,
): FieldsHost | null {
  const out: unknown[] = [];
  const visiting = new Set<Identity>([identity]);

  const walk = (entries: unknown[]): boolean => {
    for (const e of entries) {
      if (!isInclude(e)) {
        out.push(e);
        continue;
      }
      const refStr = e.include;
      const ref = safeParseRef(refStr, identity, diag);
      if (ref === null) continue;
      if (!INCLUDE_REF_KINDS.has(ref.kind)) {
        diag.add({
          category: 'kind_mismatch',
          file: identity,
          line: 1,
          column: 1,
          message: `include target must be mixin, got ${refStr}`,
        });
        continue;
      }
      const targetId = refToIdentity(ref);
      const target = parsed.get(targetId);
      if (!target) {
        diag.add({
          category: 'dangling_ref',
          file: identity,
          line: 1,
          column: 1,
          message: `dangling $ref "${refStr}" (no node with that id)`,
        });
        continue;
      }
      deps.get(identity)?.add(targetId);
      if (visiting.has(targetId)) {
        diag.add({
          category: 'cycle',
          file: identity,
          line: 1,
          column: 1,
          message: `mixin cycle detected: ${[...visiting, targetId].join(' → ')}`,
        });
        return false;
      }
      visiting.add(targetId);
      const targetFields = (target.data as { fields?: unknown[] }).fields ?? [];
      if (!walk(targetFields)) return false;
      visiting.delete(targetId);
    }
    return true;
  };

  if (!walk(host.fields)) return null;
  (host.fields as unknown[]) = out;
  return host;
}

/**
 * Resolve every field's `type:` value (spec v2 §3, §4.6).
 *
 *   - single-segment name  → resolveShortName against scalars + using
 *   - three-segment name   → direct fqn; verify target is a value_type node
 *
 * Single-segment names that resolve to scalars stay as-is. Names resolved
 * via using are rewritten to their fqn so downstream passes don't need
 * the using context.
 */
function resolveFieldTypes(
  host: FieldsHost,
  identity: Identity,
  using: readonly string[],
  scalars: ReadonlySet<string>,
  valueTypes: ReadonlySet<string>,
  typeParams: ReadonlySet<string>,
  parsed: ReadonlyMap<string, AnyFile>,
  diag: Diagnostics,
  deps: Map<Identity, Set<Identity>>,
): void {
  for (const e of host.fields) {
    if (typeof e !== 'object' || e === null) continue;
    if (!('type' in e)) continue;
    const rawType = (e as { type: unknown }).type;
    // Normalize shorthand string → {ref, args?, meta?}; downstream sees object only.
    const descriptor = normalizeType(rawType as string | TypeDescriptor);
    // Write back the normalized form so consumers (validate, expand) see object.
    (e as Record<string, unknown>).type = descriptor;

    // Type parameter reference (e.g. type: T inside a generic value_type):
    // leave as-is; instantiation happens at expansion when args are passed.
    if (typeParams.has(descriptor.ref)) continue;

    const threeSeg = parseTypeRef(descriptor.ref);
    if (threeSeg !== null) {
      resolveThreeSegment(e as Record<string, unknown>, threeSeg, identity, parsed, diag, deps);
    } else {
      resolveSingleSegment(
        e as Record<string, unknown>,
        descriptor.ref,
        identity,
        using,
        scalars,
        valueTypes,
        diag,
        deps,
      );
    }
  }
}

function resolveThreeSegment(
  field: Record<string, unknown>,
  ref: TypeRef,
  identity: Identity,
  parsed: ReadonlyMap<string, AnyFile>,
  diag: Diagnostics,
  deps: Map<Identity, Set<Identity>>,
): void {
  const fqn = `${ref.system}.${ref.module}.${ref.name}`;
  const targetId = `value_type:${fqn}`;
  const target = parsed.get(targetId);

  if (!target) {
    // Check if any node with this fqn exists (for better error message)
    const anyNode = [...parsed.entries()].find(([id]) => id.endsWith(`:${fqn}`));
    if (anyNode) {
      diag.add({
        category: 'kind_mismatch',
        file: identity,
        line: 1,
        column: 1,
        message: `type reference "${fqn}" resolves to kind=${anyNode[1].kind}, expected value_type`,
      });
      return;
    }
    diag.add({
      category: 'dangling_ref',
      file: identity,
      line: 1,
      column: 1,
      message: `unknown type "${fqn}"`,
    });
    return;
  }

  if (target.kind !== 'value_type') {
    diag.add({
      category: 'kind_mismatch',
      file: identity,
      line: 1,
      column: 1,
      message: `type reference "${fqn}" resolves to kind=${target.kind}, expected value_type`,
    });
    return;
  }
  deps.get(identity)?.add(targetId);
}

function resolveSingleSegment(
  field: Record<string, unknown>,
  shortName: string,
  identity: Identity,
  using: readonly string[],
  scalars: ReadonlySet<string>,
  valueTypes: ReadonlySet<string>,
  diag: Diagnostics,
  deps: Map<Identity, Set<Identity>>,
): void {
  // Form validation: single-segment means "no dots". If the caller passed
  // something with dots that parseTypeRef rejected (e.g. 2 or 4 segments),
  // it's an invalid form.
  if (shortName.includes('.')) {
    diag.add({
      category: 'parse',
      file: identity,
      line: 1,
      column: 1,
      message: `invalid type reference "${shortName}"`,
    });
    return;
  }

  const result = resolveShortName(shortName, using, scalars, valueTypes);
  switch (result.kind) {
    case 'scalar':
      // Stays as-is; base_types short name flows to the projector.
      return;
    case 'value_type': {
      // Rewrite the descriptor's ref to its fqn; args/meta stay attached.
      const desc = field.type as TypeDescriptor;
      desc.ref = result.fqn;
      const targetId = `value_type:${result.fqn}`;
      deps.get(identity)?.add(targetId);
      return;
    }
    case 'ambiguous':
      diag.add({
        category: 'schema',
        file: identity,
        line: 1,
        column: 1,
        message: `ambiguous type reference "${shortName}", candidates: ${result.candidates.join(', ')}`,
      });
      return;
    case 'unknown':
      diag.add({
        category: 'schema',
        file: identity,
        line: 1,
        column: 1,
        message: `unknown type "${shortName}"`,
      });
      return;
  }
}

function safeParseRef(
  s: string,
  file: string,
  diag: Diagnostics,
): { kind: FileKind; system: string; module: string; name: string } | null {
  try {
    return parseRef(s);
  } catch {
    diag.add({
      category: 'parse',
      file,
      line: 1,
      column: 1,
      message: `malformed $ref "${s}"`,
    });
    return null;
  }
}

function refToIdentity(r: {
  kind: FileKind;
  system: string;
  module: string;
  name: string;
}): string {
  return `${r.kind}:${r.system}.${r.module}.${r.name}`;
}
