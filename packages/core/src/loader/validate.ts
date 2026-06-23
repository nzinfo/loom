import type { Diagnostics } from '../errors.js';
import type { Entity, Table, TypeDescriptor, TypeField, TypeNode } from '../ir/schemas.js';
import type { ExtensionFieldEntry, FileKind, IR } from '../ir/version.js';
import { findPosition, findPositionByValue } from './yaml_position.js';

/**
 * Pass 3 — semantic validation. See spec §13.1, §6.9, §7.5 (v2).
 *
 * Cross-file rules that Zod cannot express:
 *   - every field `type:` single-segment name is a known scalar (form: scalar
 *     under base.core)
 *   - every scalar property flagged required is present in type.args
 *   - table.primary_key entries are all required:true fields
 *   - extension_fields targets an entity whose primary_table is sidecar_eav
 *
 * (v2: three-segment type refs are validated at the referenced type file.)
 */
export interface ValidateOptions {
  readonly ir: IR;
  readonly diagnostics: Diagnostics;
}

export interface ValidateResult {
  readonly diagnostics: Diagnostics;
}

type FieldLike = TypeField;

/** Look up position from a node's sourceText and a YAML path. */
function pos(
  node: { sourceText?: string } | undefined,
  path: string,
): { line: number; column: number } {
  if (node?.sourceText) {
    const p = findPosition(node.sourceText, path);
    if (p) return p;
  }
  return { line: 1, column: 1 };
}

export function validate(opts: ValidateOptions): ValidateResult {
  // Required-properties per scalar, keyed by the scalar's fqn (e.g.
  // "base.core.decimal"). After unified resolution all field type refs are
  // fqns, so we look up by fqn.
  const scalarReqProps = collectScalarRequiredProps(opts.ir);

  // Detect dependency cycles before other checks.
  checkCycles(opts.ir.deps, opts.diagnostics);

  for (const [identity, node] of opts.ir.nodes) {
    switch (node.kind) {
      case 'type': {
        const data = node.data;
        // enum form (variants) has no typed fields to check.
        if (data.form === 'enum') break;
        for (const f of (data.fields as FieldLike[] | undefined) ?? []) {
          checkTypedField(identity, node.kind, f, scalarReqProps, opts.diagnostics);
        }
        break;
      }
      case 'table': {
        checkTable(identity, node.data, scalarReqProps, node, opts.diagnostics);
        break;
      }
      case 'entity': {
        checkEntity(identity, node.data, opts.ir, opts.diagnostics);
        break;
      }
      default:
        break;
    }
  }

  // extension_fields live in ir.extensionFields (aggregated by link), not in
  // ir.nodes. Validate each entity's extension bucket: scalar types must be
  // known scalars, and the target entity must exist with a sidecar_eav
  // primary_table (spec §7, §6.9).
  for (const [entityId, entries] of opts.ir.extensionFields) {
    for (const entry of entries) {
      checkExtensionEntry(entityId, entry, scalarReqProps, opts.ir, opts.diagnostics);
    }
    checkExtensionTarget(entityId, opts.ir, opts.diagnostics);
  }

  return { diagnostics: opts.diagnostics };
}

/** Collect scalar (form: scalar) required-properties, keyed by BOTH the
 * scalar's fqn (e.g. "base.core.decimal") and its short name (e.g. "decimal").
 *
 * Field type refs (post-link) are fqns, so checkTypedField looks up by fqn.
 * Extension field entries store the raw short name (they bypass
 * resolveFieldTypes), so checkExtensionEntry looks up by short name. */
function collectScalarRequiredProps(ir: IR): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();

  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'type') continue;
    const data = node.data;
    if (data.form !== 'scalar') continue;
    if (!identity.startsWith('type:base.core.')) continue;
    const fqn = identity.slice('type:'.length);
    const req = new Set<string>();
    for (const p of data.properties ?? []) {
      if (p.required) req.add(p.name);
    }
    m.set(fqn, req);
    m.set(data.name, req); // short name alias for extension-field lookups
  }
  return m;
}

function checkTypedField(
  identity: string,
  hostKind: FileKind,
  f: FieldLike,
  scalarReqProps: Map<string, Set<string>>,
  diag: Diagnostics,
): void {
  if (scalarReqProps.size === 0) return;
  const typeVal = f.type as string | TypeDescriptor | undefined;
  if (typeVal === undefined) return;
  // link pass normalizes string → object and rewrites short names to fqns,
  // so ref is a fully-qualified name (e.g. "base.core.decimal").
  const ref = typeof typeVal === 'string' ? typeVal : typeVal.ref;

  // Only scalar-form types declare required properties. If ref isn't a known
  // scalar fqn, it's a struct/enum type ref — those are validated at the
  // referenced type file itself (existence/kind checked in link).
  const req = scalarReqProps.get(ref);
  if (req === undefined) return;

  const args = typeof typeVal === 'object' && typeVal.args ? typeVal.args : {};
  for (const rp of req) {
    if (!(rp in args)) {
      diag.add({
        category: 'schema',
        file: identity,
        line: 1,
        column: 1,
        message: `scalar "${ref}" requires property "${rp}" in type.args`,
      });
    }
  }
}

function checkTable(
  identity: string,
  t: Table,
  scalarReqProps: Map<string, Set<string>>,
  nodeSource: { sourceText?: string } | undefined,
  diag: Diagnostics,
): void {
  const requiredFieldNames = new Set<string>();
  for (const f of t.fields) {
    const fieldRec = f as FieldLike;
    if (typeof fieldRec.name === 'string' && fieldRec.required === true) {
      requiredFieldNames.add(fieldRec.name);
    }
    checkTypedField(identity, 'table', fieldRec, scalarReqProps, diag);
  }
  for (let pki = 0; pki < t.primary_key.length; pki++) {
    const pk = t.primary_key[pki]!;
    if (!requiredFieldNames.has(pk)) {
      const p = pos(nodeSource, `primary_key.${pki}`);
      diag.add({
        category: 'semantic',
        file: identity,
        line: p.line,
        column: p.column,
        message: `primary_key field "${pk}" must be required:true`,
      });
    }
  }

  // Reject unimplemented strategies.
  if (t.table.extension.strategy === 'json_column') {
    diag.add({
      category: 'semantic',
      file: identity,
      line: 1,
      column: 1,
      message: `json_column strategy is not yet implemented; use sidecar_eav or none`,
    });
  }

  // #7: Validate column existence for primary_key, indexes, foreign_keys.
  const columnNames = new Set<string>();
  for (const f of t.fields) {
    const fn = (f as FieldLike).name;
    if (typeof fn === 'string') columnNames.add(fn);
  }
  // Note: multi-field struct refs expand to prefixed names not present as
  // top-level fields, so we only check single-name references here.

  for (const idx of t.indexes ?? []) {
    for (const col of idx.fields) {
      if (!columnNames.has(col)) {
        diag.add({
          category: 'semantic',
          file: identity,
          line: 1,
          column: 1,
          message: `index "${idx.name}" references unknown field "${col}"`,
        });
      }
    }
  }
  for (const fk of t.foreign_keys ?? []) {
    for (const col of fk.fields) {
      if (!columnNames.has(col)) {
        diag.add({
          category: 'semantic',
          file: identity,
          line: 1,
          column: 1,
          message: `foreign key "${fk.name}" references unknown field "${col}"`,
        });
      }
    }
  }
}

/**
 * Validate an entity node.
 *
 * Checks that business_keys reference real columns on the primary_table.
 */
function checkEntity(identity: string, entity: Entity, ir: IR, diag: Diagnostics): void {
  if (!entity.business_keys || entity.business_keys.length === 0) return;

  // Resolve the primary_table to get its field names.
  const tableNode = ir.nodes.get(entity.primary_table);
  if (!tableNode || tableNode.kind !== 'table') return; // already checked elsewhere

  const table = tableNode.data as Table;
  const columnNames = new Set<string>();
  for (const f of table.fields) {
    const fn = (f as FieldLike).name;
    if (typeof fn === 'string') columnNames.add(fn);
  }

  for (const bk of entity.business_keys) {
    if (!columnNames.has(bk)) {
      diag.add({
        category: 'semantic',
        file: identity,
        line: 1,
        column: 1,
        message: `business_key "${bk}" is not a field on ${entity.primary_table}`,
      });
    }
  }
}

/**
 * Validate a single extension field entry's scalar type.
 *
 * Extension entries store the raw short name in `scalar` (they bypass
 * resolveFieldTypes). scalarReqProps is keyed by both fqn and short name, so
 * we look up by the short name. Type refs (refValueTypeId set) are validated
 * at the referenced type file itself.
 */
function checkExtensionEntry(
  entityId: string,
  entry: ExtensionFieldEntry,
  scalarReqProps: Map<string, Set<string>>,
  ir: IR,
  diag: Diagnostics,
): void {
  if (entry.refValueTypeId !== undefined) {
    const refNode = ir.nodes.get(entry.refValueTypeId);
    if (!refNode || refNode.kind !== 'type') {
      const p = entry.sourceText ? findPositionByValue(entry.sourceText, entry.name) : undefined;
      diag.add({
        category: 'semantic',
        file: entityId,
        line: p?.line ?? 1,
        column: p?.column ?? 1,
        message: `extension field "${entry.name}" references unknown type "${entry.refValueTypeId}"`,
      });
    }
    return;
  }
  if (entry.scalar === '') return;
  if (scalarReqProps.size === 0) return;
  const req = scalarReqProps.get(entry.scalar);
  if (req === undefined) {
    const p = entry.sourceText ? findPositionByValue(entry.sourceText, entry.name) : undefined;
    diag.add({
      category: 'schema',
      file: entityId,
      line: p?.line ?? 1,
      column: p?.column ?? 1,
      message: `unknown scalar type "${entry.scalar}" for extension field "${entry.name}"`,
    });
    return;
  }
  for (const rp of req) {
    if (!(rp in entry.props)) {
      diag.add({
        category: 'schema',
        file: entityId,
        line: 1,
        column: 1,
        message: `scalar "${entry.scalar}" requires property "${rp}" on extension field "${entry.name}"`,
      });
    }
  }
}

function checkExtensionTarget(entityId: string, ir: IR, diag: Diagnostics): void {
  const entityNode = ir.nodes.get(entityId);
  if (!entityNode || entityNode.kind !== 'entity') {
    diag.add({
      category: 'semantic',
      file: entityId,
      line: 1,
      column: 1,
      message: `extension_fields entity "${entityId}" does not exist`,
    });
    return;
  }
  const ent = entityNode.data as Entity;
  const tableNode = ir.nodes.get(ent.primary_table);
  if (!tableNode || tableNode.kind !== 'table') {
    diag.add({
      category: 'semantic',
      file: entityId,
      line: 1,
      column: 1,
      message: `extension_fields entity "${entityId}" primary_table "${ent.primary_table}" is not a table`,
    });
    return;
  }
  const table = tableNode.data as Table;
  if (table.table.extension.strategy !== 'sidecar_eav') {
    diag.add({
      category: 'semantic',
      file: entityId,
      line: 1,
      column: 1,
      message: `extension_fields requires sidecar_eav strategy on entity "${entityId}"`,
    });
  }
}

/**
 * Detect cycles in the dependency graph using DFS.
 * Reports a 'cycle' diagnostic for each cycle found.
 */
function checkCycles(deps: ReadonlyMap<string, ReadonlySet<string>>, diag: Diagnostics): void {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();

  function dfs(node: string, path: string[]): boolean {
    color.set(node, GRAY);
    const neighbors = deps.get(node);
    if (neighbors) {
      for (const dep of neighbors) {
        const c = color.get(dep) ?? WHITE;
        if (c === GRAY) {
          const cycle = [...path, dep];
          const idx = cycle.indexOf(dep);
          diag.add({
            category: 'cycle',
            file: node,
            line: 1,
            column: 1,
            message: `dependency cycle: ${cycle.slice(idx).join(' → ')}`,
          });
          return true;
        }
        if (c === WHITE) {
          if (dfs(dep, [...path, dep])) return true;
        }
      }
    }
    color.set(node, BLACK);
    return false;
  }

  for (const [node] of deps) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      dfs(node, [node]);
    }
  }
}
