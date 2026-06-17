import type { Diagnostics } from '../errors.js';
import { parseRef } from '../ir/refs.js';
import type { AnyFile } from '../ir/schemas.js';
import type { IR, IRNode, Identity } from '../ir/version.js';
import type { FileKind } from '../ir/version.js';
import { CURRENT_VERSION } from '../ir/version.js';

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

/** Ref kinds legal in a `ref:` field of a fields[] entry. */
const FIELD_REF_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['value_type']);

/** Ref kinds legal as a mixin include target. */
const INCLUDE_REF_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['mixin']);

export async function link(opts: LinkOptions): Promise<LinkResult> {
  const nodes = new Map<Identity, IRNode>();
  const deps = new Map<Identity, Set<Identity>>();

  // Lift all parsed files into IRNodes keyed by identity. We need the full set
  // available before resolving refs.
  for (const [identity, file] of opts.parsed) {
    nodes.set(identity, { ...file, identity });
    deps.set(identity, new Set());
  }

  // Resolve refs + expand mixins per file.
  for (const [identity, node] of nodes) {
    const fieldsHost = fieldsOf(node);
    if (fieldsHost === null) continue;

    const expanded = expandIncludes(fieldsHost, identity, opts.parsed, opts.diagnostics, deps);
    if (expanded === null) continue; // fatal cycle already recorded

    resolveFieldRefs(expanded, identity, opts.parsed, opts.diagnostics, deps);

    // Rebuild the node with expanded/resolved fields.
    nodes.set(identity, withFields(node, expanded));
  }

  const ir: IR = {
    nodes: nodes as ReadonlyMap<Identity, IRNode>,
    deps: deps as ReadonlyMap<Identity, ReadonlySet<Identity>>,
    version: CURRENT_VERSION,
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

function resolveFieldRefs(
  host: FieldsHost,
  identity: Identity,
  parsed: ReadonlyMap<string, AnyFile>,
  diag: Diagnostics,
  deps: Map<Identity, Set<Identity>>,
): void {
  for (const e of host.fields) {
    if (typeof e !== 'object' || e === null) continue;
    if (!('ref' in e)) continue;
    const refStr = (e as { ref: string }).ref;
    const ref = safeParseRef(refStr, identity, diag);
    if (ref === null) continue;
    if (!FIELD_REF_KINDS.has(ref.kind)) {
      diag.add({
        category: 'kind_mismatch',
        file: identity,
        line: 1,
        column: 1,
        message: `field ref must target value_type, got ${refStr}`,
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
