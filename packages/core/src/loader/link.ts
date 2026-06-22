import type { Diagnostics } from '../errors.js';
import { parseRef } from '../ir/refs.js';
import type { AnyFile, ExtensionFields, TypeDescriptor, TypeNode } from '../ir/schemas.js';
import { type TypeRef, normalizeType, parseTypeRef, resolveShortName } from '../ir/typespace.js';
import type { ExtensionFieldEntry, IR, IRNode, Identity, Owner } from '../ir/version.js';
import type { FileKind } from '../ir/version.js';
import { CURRENT_VERSION } from '../ir/version.js';
import type { DiscoveredEntry } from './discovery.js';
import type { ParsedExtensionFields } from './parse.js';

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
  /**
   * Parsed extension_fields files (each carries its identity). Multiple
   * owners may share an identity; link aggregates them into the
   * IR.extensionFields registry (spec §6.3, §7).
   */
  readonly extensionFieldsFiles?: ReadonlyArray<ParsedExtensionFields>;
  /**
   * Discovery result (path → DiscoveredEntry with meta.owner). Used to
   * stamp the real owner onto each IRNode. Optional for tests that bypass
   * discovery; absent owner defaults to platform.
   */
  readonly files?: ReadonlyMap<string, DiscoveredEntry>;
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
  // (parse already split extension_fields out into opts.extensionFieldsFiles;
  // parsed contains only node-defining kinds.)
  for (const [identity, file] of opts.parsed) {
    const owner = ownerOfFile(file.file, opts.files);
    nodes.set(identity, { ...file, identity, owner });
    deps.set(identity, new Set());
  }

  // Collect the unified type set: all type-node fqns (scalar + struct + enum).
  // Short-name resolution uses ONLY this set + the using list (which always
  // includes the implicit default base.core.*). No scalar special-case.
  const typeFqns = collectTypeFqns(opts.parsed);

  // Resolve type refs + expand mixins per file.
  for (const [identity, node] of nodes) {
    const fieldsHost = fieldsOf(node);
    if (fieldsHost === null) continue;

    const expanded = expandIncludes(fieldsHost, identity, opts.parsed, opts.diagnostics, deps);
    if (expanded === null) continue;

    const fileUsing = collectUsing(node);
    resolveFieldTypes(expanded, identity, fileUsing, typeFqns, opts.parsed, opts.diagnostics, deps);

    nodes.set(identity, withFields(node, expanded));
  }

  // Aggregate extension_fields across owners into the registry keyed by
  // entity identity. Same-name field across owners on the same entity is
  // a hard error (spec §7).
  const extensionFields = collectExtensionFields(opts.extensionFieldsFiles ?? [], opts.diagnostics);

  const ir: IR = {
    nodes: nodes as ReadonlyMap<Identity, IRNode>,
    deps: deps as ReadonlyMap<Identity, ReadonlySet<Identity>>,
    version: CURRENT_VERSION,
    extensionFields,
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

/** Collect ALL type-node fully-qualified names (sys.mod.declaredName).
 *
 * Identity now uses the declared name (parse corrects it), so the fqn is
 * simply the identity body. Unified resolution: scalar/struct/enum are all
 * equal — they resolve through the using namespace (which always includes
 * the implicit base.core.* default). See design note §4. */
function collectTypeFqns(parsed: ReadonlyMap<string, AnyFile>): Set<string> {
  const fqns = new Set<string>();
  for (const [identity, f] of parsed) {
    if (f.kind !== 'type') continue;
    const colonIdx = identity.indexOf(':');
    if (colonIdx < 0) continue;
    fqns.add(identity.slice(colonIdx + 1));
  }
  return fqns;
}

/** Look up the owner for a file by its path from the discovery files map.
 * Identity can't be used because parse corrects it (declared name overrides
 * the stem-derived provisional identity), so discovery's identity no longer
 * matches the node's. Path is stable. */
function ownerOfFile(filePath: string, files?: ReadonlyMap<string, DiscoveredEntry>): Owner {
  if (files !== undefined) {
    const entry = files.get(filePath);
    if (entry !== undefined) return entry.meta.owner;
  }
  return { kind: 'platform' };
}

/**
 * Aggregate extension_fields files into the registry keyed by entity
 * identity. Same-name field on the same entity across owners (or within
 * one file) is a hard error (spec §7).
 *
 * Each entry's `type:` is normalized via normalizeType. Single-segment refs
 * become `scalar`; three-segment refs become `refValueTypeId`.
 */
function collectExtensionFields(
  extensionFieldsFiles: ReadonlyArray<ParsedExtensionFields>,
  diag: Diagnostics,
): Map<Identity, ReadonlyArray<ExtensionFieldEntry>> {
  const byEntity = new Map<Identity, ExtensionFieldEntry[]>();
  // Track which file first contributed each (entity, fieldName) for error msgs.
  const seen = new Map<string, string>();

  for (const { identity, file } of extensionFieldsFiles) {
    const ef = file.data as ExtensionFields;
    const entityRef = ef.entity;

    let bucket = byEntity.get(entityRef);
    if (bucket === undefined) {
      bucket = [];
      byEntity.set(entityRef, bucket);
    }

    for (const f of ef.fields as ReadonlyArray<Record<string, unknown>>) {
      if ('include' in f) continue;
      const desc = normalizeType((f.type as string | TypeDescriptor | undefined) ?? '');
      const fieldName = String(f.name ?? '');
      const key = `${entityRef}::${fieldName}`;
      const prev = seen.get(key);
      if (prev !== undefined) {
        diag.add({
          category: 'schema',
          file: identity,
          line: 1,
          column: 1,
          message: `duplicate extension field "${fieldName}" on entity ${entityRef} (also declared in ${prev})`,
        });
        continue;
      }
      seen.set(key, identity);

      const ref = desc.ref;
      if (ref.includes('.')) {
        bucket.push({
          name: fieldName,
          scalar: '',
          refValueTypeId: `type:${ref}`,
          props: desc.args ?? {},
          ...(f.default_scope !== undefined ? { defaultScope: String(f.default_scope) } : {}),
        });
      } else {
        bucket.push({
          name: fieldName,
          scalar: ref,
          props: desc.args ?? {},
          ...(f.default_scope !== undefined ? { defaultScope: String(f.default_scope) } : {}),
        });
      }
    }
  }

  return byEntity;
}

/** Read the file's optional using list (empty if absent). */
function collectUsing(node: IRNode): readonly string[] {
  const data = node.data as { using?: unknown };
  if (Array.isArray(data.using))
    return data.using.filter((s): s is string => typeof s === 'string');
  return [];
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
 * Resolve every field's `type:` value (spec v2 §3, §4.6, unified).
 *
 *   - single-segment name  → resolveShortName against using (incl. implicit
 *                            base.core.* default); rewrite to fqn on hit
 *   - three-segment name   → direct fqn; verify target is a type node
 *
 * All short names that resolve are rewritten to their fqn so downstream
 * passes (validate, expand) see only fqns and branch by the target's form.
 */
function resolveFieldTypes(
  host: FieldsHost,
  identity: Identity,
  using: readonly string[],
  typeFqns: ReadonlySet<string>,
  parsed: ReadonlyMap<string, AnyFile>,
  diag: Diagnostics,
  deps: Map<Identity, Set<Identity>>,
): void {
  // The implicit default base.core.* is always available — every type in
  // base.core (scalar AND struct/enum) is globally resolvable by short name.
  const usingWithDefault = using.includes('base.core.*') ? using : [...using, 'base.core.*'];
  for (const e of host.fields) {
    if (typeof e !== 'object' || e === null) continue;
    if (!('type' in e)) continue;
    const rawType = (e as { type: unknown }).type;
    // Normalize shorthand string → {ref, args?, meta?}; downstream sees object only.
    const descriptor = normalizeType(rawType as string | TypeDescriptor);
    // Write back the normalized form so consumers (validate, expand) see object.
    (e as Record<string, unknown>).type = descriptor;

    const threeSeg = parseTypeRef(descriptor.ref);
    if (threeSeg !== null) {
      resolveThreeSegment(e as Record<string, unknown>, threeSeg, identity, parsed, diag, deps);
    } else {
      resolveSingleSegment(
        e as Record<string, unknown>,
        descriptor.ref,
        identity,
        usingWithDefault,
        typeFqns,
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
  const targetId = `type:${fqn}`;
  const target = parsed.get(targetId);

  if (target) {
    deps.get(identity)?.add(targetId);
    return;
  }

  // No type node with this fqn. Check whether ANY node has it (different kind)
  // for a clearer kind_mismatch diagnostic.
  const anyNode = [...parsed.entries()].find(([id]) => id.endsWith(`:${fqn}`));
  if (anyNode) {
    diag.add({
      category: 'kind_mismatch',
      file: identity,
      line: 1,
      column: 1,
      message: `type reference "${fqn}" resolves to kind=${anyNode[1].kind}, expected type`,
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
}

function resolveSingleSegment(
  field: Record<string, unknown>,
  shortName: string,
  identity: Identity,
  using: readonly string[],
  typeFqns: ReadonlySet<string>,
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

  // Unified resolution: ALL types (scalar/struct/enum) resolve the same way —
  // through the using namespace. base.core.* is in `using` by default, so
  // base.core types resolve by short name; ext types need explicit using.
  const result = resolveShortName(shortName, using, typeFqns);
  switch (result.kind) {
    case 'resolved': {
      // Rewrite the descriptor's ref to its fqn; args/meta stay attached.
      // Identity == declared-name fqn (parse corrects it), so the fqn IS the
      // identity body — expand looks it up directly.
      const desc = field.type as TypeDescriptor;
      desc.ref = result.fqn;
      const targetId = `type:${result.fqn}`;
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
