import type { Diagnostics } from '../errors.js';
import type { Entity, Table, TypeDescriptor, TypeNode } from '../ir/schemas.js';
import type { ExtensionFieldEntry, FileKind, IR } from '../ir/version.js';

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

type FieldLike = Record<string, unknown>;

interface ScalarInfo {
  readonly name: string;
  readonly requiredProps: Set<string>;
}

export function validate(opts: ValidateOptions): ValidateResult {
  const scalars = collectScalars(opts.ir);
  const scalarNames = new Set<string>(scalars.map((s) => s.name));
  const requiredProps = new Map<string, Set<string>>(scalars.map((s) => [s.name, s.requiredProps]));

  for (const [identity, node] of opts.ir.nodes) {
    switch (node.kind) {
      case 'type': {
        const data = node.data as TypeNode;
        // enum form (variants) has no typed fields to check.
        if (data.form === 'enum') break;
        const localTypeParams = new Set<string>((data.type_parameters ?? []).map((p) => p.name));
        for (const f of (data.fields as FieldLike[] | undefined) ?? []) {
          checkTypedField(
            identity,
            node.kind,
            f,
            scalarNames,
            requiredProps,
            opts.diagnostics,
            localTypeParams,
          );
        }
        break;
      }
      case 'mixin': {
        const data = node.data as { fields?: FieldLike[] };
        for (const f of data.fields ?? []) {
          checkTypedField(identity, node.kind, f, scalarNames, requiredProps, opts.diagnostics);
        }
        break;
      }
      case 'table': {
        checkTable(identity, node.data as Table, scalarNames, requiredProps, opts.diagnostics);
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
      checkExtensionEntry(entityId, entry, scalarNames, requiredProps, opts.diagnostics);
    }
    checkExtensionTarget(entityId, opts.ir, opts.diagnostics);
  }

  return { diagnostics: opts.diagnostics };
}

/** Collect scalar (form: scalar) info from base.core type nodes. */
function collectScalars(ir: IR): ScalarInfo[] {
  const out: ScalarInfo[] = [];
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'type') continue;
    const data = node.data as TypeNode;
    if (data.form !== 'scalar') continue;
    if (!identity.startsWith('type:base.core.')) continue;
    const requiredProps = new Set<string>();
    for (const p of data.properties ?? []) {
      if (p.required) requiredProps.add(p.name);
    }
    out.push({ name: data.name, requiredProps });
  }
  return out;
}

function checkTypedField(
  identity: string,
  hostKind: FileKind,
  f: FieldLike,
  scalarNames: Set<string>,
  requiredProps: Map<string, Set<string>>,
  diag: Diagnostics,
  typeParams: ReadonlySet<string> = new Set(),
): void {
  if (scalarNames.size === 0) return;
  const typeVal = f.type as string | TypeDescriptor | undefined;
  if (typeVal === undefined) return;
  // link pass normalizes string → object; accept either for safety.
  const ref = typeof typeVal === 'string' ? typeVal : typeVal.ref;
  // Three-segment (type ref): skip — validated at the referenced type file.
  if (ref.includes('.')) return;

  // Type parameter reference inside a generic host (e.g. type: T inside a
  // struct type that declares type_parameters): skip — bound at
  // instantiation time in the projector.
  if (typeParams.has(ref)) return;

  // Single-segment: must be a known scalar.
  if (!scalarNames.has(ref)) {
    diag.add({
      category: 'schema',
      file: identity,
      line: 1,
      column: 1,
      message: `unknown scalar type "${ref}" (not a declared scalar)`,
    });
    return;
  }
  const req = requiredProps.get(ref) ?? new Set<string>();
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
  scalarNames: Set<string>,
  requiredProps: Map<string, Set<string>>,
  diag: Diagnostics,
): void {
  const requiredFieldNames = new Set<string>();
  for (const f of t.fields) {
    const fieldRec = f as FieldLike;
    if (typeof fieldRec.name === 'string' && fieldRec.required === true) {
      requiredFieldNames.add(fieldRec.name);
    }
    checkTypedField(identity, 'table', fieldRec, scalarNames, requiredProps, diag);
  }
  for (const pk of t.primary_key) {
    if (!requiredFieldNames.has(pk)) {
      diag.add({
        category: 'semantic',
        file: identity,
        line: 1,
        column: 1,
        message: `primary_key field "${pk}" must be required:true`,
      });
    }
  }
}

/**
 * Validate a single extension field entry's scalar type.
 *
 * Single-segment (scalar) refs must be a known scalar and supply any required
 * properties. Type refs (refValueTypeId set) are validated at the referenced
 * type file itself.
 */
function checkExtensionEntry(
  entityId: string,
  entry: ExtensionFieldEntry,
  scalarNames: Set<string>,
  requiredProps: Map<string, Set<string>>,
  diag: Diagnostics,
): void {
  if (entry.refValueTypeId !== undefined) return; // type ref — checked elsewhere
  if (entry.scalar === '') return;
  if (scalarNames.size === 0) return;
  if (!scalarNames.has(entry.scalar)) {
    diag.add({
      category: 'schema',
      file: entityId,
      line: 1,
      column: 1,
      message: `unknown scalar type "${entry.scalar}" for extension field "${entry.name}"`,
    });
    return;
  }
  const req = requiredProps.get(entry.scalar) ?? new Set<string>();
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
