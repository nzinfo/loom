import type { Diagnostics } from '../errors.js';
import type { BaseTypes, Entity, ExtensionFields, Table } from '../ir/schemas.js';
import type { IR } from '../ir/version.js';

/**
 * Pass 3 — semantic validation. See spec §13.1, §10, §6.9, §7.5.
 *
 * Cross-file rules that Zod cannot express:
 *   - every field `base` is a scalar declared in base_types
 *   - every scalar property flagged required in base_types is present on the field
 *   - table.primary_key entries are all required:true fields
 *   - extension_fields targets an entity whose primary_table is sidecar_eav
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
      case 'value_type':
      case 'mixin':
      case 'extension_fields': {
        const data = node.data as { fields?: FieldLike[] };
        for (const f of data.fields ?? []) {
          checkScalarField(identity, f, scalarNames, requiredProps, opts.diagnostics);
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

function checkScalarField(
  identity: string,
  f: FieldLike,
  scalarNames: Set<string>,
  requiredProps: Map<string, Set<string>>,
  diag: Diagnostics,
): void {
  if (scalarNames.size === 0) return;
  const base = f.base;
  if (typeof base !== 'string') return;
  if (!scalarNames.has(base)) {
    diag.add({
      category: 'schema',
      file: identity,
      line: 1,
      column: 1,
      message: `unknown scalar type "${base}" (not in base_types)`,
    });
    return;
  }
  const req = requiredProps.get(base) ?? new Set<string>();
  for (const rp of req) {
    if (!(rp in f)) {
      diag.add({
        category: 'schema',
        file: identity,
        line: 1,
        column: 1,
        message: `scalar "${base}" requires property "${rp}" (base_types)`,
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
    checkScalarField(identity, fieldRec, scalarNames, requiredProps, diag);
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
