import type { Diagnostics } from '../errors.js';
import type { BaseTypes, Entity, ExtensionFields, Table, TypeDescriptor } from '../ir/schemas.js';
import type { FileKind, IR } from '../ir/version.js';

/**
 * Pass 3 — semantic validation. See spec §13.1, §6.9, §7.5 (v2).
 *
 * Cross-file rules that Zod cannot express:
 *   - every field `type:` single-segment name is a scalar declared in base_types
 *   - every scalar property flagged required in base_types is present in type.args
 *   - table.primary_key entries are all required:true fields
 *   - extension_fields targets an entity whose primary_table is sidecar_eav
 *
 * (v2: three-segment value_type refs are validated at the value_type file.)
 */
export interface ValidateOptions {
  readonly ir: IR;
  readonly diagnostics: Diagnostics;
}

export interface ValidateResult {
  readonly diagnostics: Diagnostics;
}

type FieldLike = Record<string, unknown>;

export function validate(opts: ValidateOptions): ValidateResult {
  const baseTypes = findBaseTypes(opts.ir);
  const scalarNames = new Set<string>(baseTypes?.scalars.map((s) => s.name) ?? []);
  const requiredProps = indexRequiredProps(baseTypes);

  for (const [identity, node] of opts.ir.nodes) {
    switch (node.kind) {
      case 'value_type': {
        // value_type has two mutually exclusive forms: fields or variants.
        // variants form (sum type) has no typed fields to check.
        const data = node.data as {
          fields?: FieldLike[];
          variants?: unknown[];
          type_parameters?: Array<{ name: string }>;
        };
        if (data.variants && data.variants.length > 0) break;
        const localTypeParams = new Set<string>((data.type_parameters ?? []).map((p) => p.name));
        for (const f of data.fields ?? []) {
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
      case 'mixin':
      case 'extension_fields': {
        const data = node.data as { fields?: FieldLike[] };
        for (const f of data.fields ?? []) {
          checkTypedField(identity, node.kind, f, scalarNames, requiredProps, opts.diagnostics);
        }
        if (node.kind === 'extension_fields') {
          checkExtensionTarget(identity, node.data as ExtensionFields, opts.ir, opts.diagnostics);
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

  return { diagnostics: opts.diagnostics };
}

function findBaseTypes(ir: IR): BaseTypes | null {
  for (const node of ir.nodes.values()) {
    if (node.kind === 'base_types') return node.data as BaseTypes;
  }
  return null;
}

function indexRequiredProps(base: BaseTypes | null): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  if (!base) return m;
  for (const s of base.scalars) {
    const req = new Set<string>();
    for (const p of s.properties) {
      if (p.required) req.add(p.name);
    }
    m.set(s.name, req);
  }
  return m;
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
  // Three-segment (value_type ref): skip — validated at the value_type file.
  if (ref.includes('.')) return;

  // Type parameter reference inside a generic host (e.g. type: T inside
  // a value_type that declares type_parameters): skip — bound at
  // instantiation time in the projector.
  if (typeParams.has(ref)) return;

  // Single-segment: must be a known scalar.
  if (!scalarNames.has(ref)) {
    diag.add({
      category: 'schema',
      file: identity,
      line: 1,
      column: 1,
      message: `unknown scalar type "${ref}" (not in base_types)`,
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
        message: `scalar "${ref}" requires property "${rp}" in type.args (base_types)`,
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

function checkExtensionTarget(
  identity: string,
  ef: ExtensionFields,
  ir: IR,
  diag: Diagnostics,
): void {
  const entityNode = ir.nodes.get(ef.entity);
  if (!entityNode || entityNode.kind !== 'entity') {
    diag.add({
      category: 'semantic',
      file: identity,
      line: 1,
      column: 1,
      message: `extension_fields entity "${ef.entity}" does not exist`,
    });
    return;
  }
  const ent = entityNode.data as Entity;
  const tableNode = ir.nodes.get(ent.primary_table);
  if (!tableNode || tableNode.kind !== 'table') {
    diag.add({
      category: 'semantic',
      file: identity,
      line: 1,
      column: 1,
      message: `extension_fields entity "${ef.entity}" primary_table "${ent.primary_table}" is not a table`,
    });
    return;
  }
  const table = tableNode.data as Table;
  if (table.table.extension.strategy !== 'sidecar_eav') {
    diag.add({
      category: 'semantic',
      file: identity,
      line: 1,
      column: 1,
      message: `extension_fields requires sidecar_eav strategy on entity "${ef.entity}"`,
    });
  }
}
