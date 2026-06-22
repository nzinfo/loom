/**
 * Design → Physical model projector. See spec §6, §8, §11, §7.5.
 *
 * Expands design-level constructs (mixins, value_types, extension_fields)
 * into physical columns, tables, and registries.
 *
 * This is the core of the Loom projection engine.
 */

import { type ValueTypeNode, expandValueColumns, isSingleFieldValueType } from '../ir/field.js';
import type { Table, TypeDescriptor, TypeNode } from '../ir/schemas.js';
import { normalizeType } from '../ir/typespace.js';
import type { IR, IRNode } from '../ir/version.js';
import type {
  ExtensionFieldEntry,
  PhysicalColumn,
  PhysicalForeignKey,
  PhysicalIndex,
  PhysicalModel,
  PhysicalTable,
} from './types.js';

/**
 * Extract the type descriptor from a field, normalizing shorthand strings.
 * Returns `{ref, args, meta}` always; args/meta default to empty objects.
 */
function descriptorOf(field: Record<string, unknown>): TypeDescriptor {
  return normalizeType(field.type as string | TypeDescriptor);
}

/**
 * Resolve a sub-field's type ref to the scalar name a dialect expects.
 *
 * After unified resolution, a sub-field's type ref is a fully-qualified name
 * (e.g. "base.core.string"). Identity == declared-name fqn, so we look up the
 * node directly and return its `data.name` (the declared short name dialects
 * key on). Returns the ref unchanged if no node matches (e.g. a literal the
 * caller already passed through, or an unbound form).
 */
function scalarNameOf(ref: string, ir: IR): string {
  const node = ir.nodes.get(`type:${ref}`);
  if (node?.kind === 'type' && (node.data as TypeNode).form === 'scalar') {
    return (node.data as TypeNode).name;
  }
  return ref;
}

/**
 * Substitute type parameters in a generic value_type's fields with the
 * caller-supplied bindings (or declared defaults). Returns a shallow-copied
 * field list with each field's `type` rewritten where its ref names a type
 * parameter.
 *
 *   typeParams: [{name:'T', default:'base.core.integer'}]
 *   callerArgs: {T: 'decimal'}  (or {} → use default)
 *
 * For each field whose type ref is 'T', the ref is replaced with the bound
 * type (string form; any args/meta on the binding are not propagated — v2
 * only supports binding to a bare type name).
 */
function instantiateFields(
  fields: ReadonlyArray<Record<string, unknown>>,
  typeParams: ReadonlyArray<{ name: string; default?: string }>,
  callerArgs: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>> {
  const bindings = new Map<string, string>();
  for (const tp of typeParams) {
    const v = callerArgs[tp.name];
    if (typeof v === 'string') {
      bindings.set(tp.name, v);
    } else if (tp.default !== undefined) {
      bindings.set(tp.name, tp.default);
    }
  }
  if (bindings.size === 0) return fields;
  return fields.map((f) => {
    const desc = descriptorOf(f);
    if (!bindings.has(desc.ref)) return f;
    const bound = bindings.get(desc.ref);
    if (bound === undefined) return f;
    return { ...f, type: { ref: bound, ...(desc.args ? { args: desc.args } : {}) } };
  });
}

/**
 * Main entry point: project a design IR to a physical model.
 *
 * - Expands mixins into inline fields.
 * - Expands value_type refs into one or more columns.
 * - Builds ext tables for sidecar_eav.
 * - Collects enums and extension_fields into registries.
 *
 * @param ir The validated, linked IR from the loader.
 * @returns A PhysicalModel with tables, enums, and extension_fields registries.
 */
export function expandTables(
  ir: IR,
  physicalSchemaOverrides?: ReadonlyMap<string, string>,
): PhysicalModel {
  const tables: PhysicalTable[] = [];
  const enums = new Map<string, ReadonlyArray<string>>();
  // extension_fields were aggregated by the link pass into ir.extensionFields.
  // Copy them verbatim into the physical model (spec §7).
  const extensionFields = new Map<string, ReadonlyArray<ExtensionFieldEntry>>(ir.extensionFields);

  // Collect enums first (referenced during table expansion).
  collectEnums(ir, enums);

  // Expand each table node.
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'table') continue;

    const table = expandTable(node, ir, enums, extensionFields, physicalSchemaOverrides);
    tables.push(table);
  }

  return { tables, enums, extensionFields };
}

/**
 * Expand a single table IR node into a PhysicalTable.
 *
 * Handles mixin expansion, value_type expansion, extension strategy,
 * and schema qualification.
 */
function expandTable(
  node: IRNode & { kind: 'table'; data: Table },
  ir: IR,
  enums: Map<string, ReadonlyArray<string>>,
  extensionFields: Map<string, ReadonlyArray<ExtensionFieldEntry>>,
  physicalSchemaOverrides?: ReadonlyMap<string, string>,
): PhysicalTable {
  const { data } = node;
  const tableName = data.table.name;
  const strategy = data.table.extension.strategy;
  // physical_schema derives from <system>_<module>; CLI overrides may replace it.
  const identityBody = node.identity.slice('table:'.length); // <system>.<module>.<Name>
  const dot2 = identityBody.lastIndexOf('.');
  const dot1 = identityBody.lastIndexOf('.', dot2 - 1);
  const system = dot1 >= 0 ? identityBody.slice(0, dot1) : '';
  const module = dot1 >= 0 ? identityBody.slice(dot1 + 1, dot2) : '';
  const schema = physicalSchemaOf(system, module, physicalSchemaOverrides);
  const qualifiedName = `${schema}.${tableName}`;

  // Resolve all fields (including mixin includes).
  const fields = resolveFields(data.fields, ir);

  // Expand fields into columns.
  const columns = expandFields(fields, ir, enums);

  // Convert indexes and foreign keys.
  const indexes = (data.indexes ?? []).map((idx) => ({
    name: idx.name,
    columns: idx.fields,
    unique: idx.unique ?? false,
  }));

  const foreignKeys: PhysicalForeignKey[] = (data.foreign_keys ?? []).map((fk) => {
    const result: PhysicalForeignKey = {
      name: fk.name,
      columns: fk.fields,
      refTable: fk.ref_table,
      refColumns: fk.ref_fields,
      ...(fk.on_delete ? { onDelete: fk.on_delete } : {}),
    };
    return result;
  });

  const extTable = strategy === 'sidecar_eav' ? data.table.extension.ext_table : undefined;
  const view = strategy === 'sidecar_eav' ? data.table.extension.view : undefined;

  const base: PhysicalTable = {
    name: tableName,
    schema,
    qualifiedName,
    columns,
    primaryKey: data.primary_key,
    indexes,
    foreignKeys,
    strategy,
    ...(extTable ? { extTableName: extTable } : {}),
    ...(view ? { viewName: view } : {}),
  };

  return base;
}

/**
 * Resolve a table's physical schema name.
 *
 * Derived from the table's `<system>_<module>` by default. Callers may pass
 * an overrides map (e.g. `{ "retail.pos": "acme_retail_pos" }`) — typically
 * from a CLI flag — to replace the derived name per module fqn. Overrides
 * win over derivation.
 *
 * (module_manifest is gone; physical_schema is a projection-time concern,
 * not a schema declaration. See design note on module_manifest removal.)
 */
function physicalSchemaOf(
  system: string,
  module: string,
  overrides?: ReadonlyMap<string, string>,
): string {
  const fqn = `${system}.${module}`;
  const override = overrides?.get(fqn);
  if (override !== undefined) return override;
  return `${system}_${module}`;
}

/**
 * Resolve mixin includes to their constituent fields.
 *
 * Recursively expands include entries into the mixin's fields.
 * The result is a flat list of field objects (no include entries).
 */
function resolveFields(
  fields: ReadonlyArray<Record<string, unknown>>,
  ir: IR,
): ReadonlyArray<Record<string, unknown>> {
  const resolved: Record<string, unknown>[] = [];

  for (const f of fields) {
    const fRec = f as Record<string, unknown>;
    if ('include' in fRec) {
      // Resolve mixin reference.
      const mixinRef = String(fRec.include);
      const mixinNode = ir.nodes.get(mixinRef);
      if (!mixinNode) {
        throw new Error(`Mixin not found: ${mixinRef}`);
      }
      if (mixinNode.kind !== 'mixin') {
        throw new Error(`Expected mixin, got ${mixinNode.kind}`);
      }
      // Recursively resolve the mixin's fields.
      const mixinFields = resolveFields(
        mixinNode.data.fields as ReadonlyArray<Record<string, unknown>>,
        ir,
      );
      resolved.push(...mixinFields);
    } else {
      resolved.push(fRec);
    }
  }

  return resolved;
}

/**
 * Expand multiple fields into columns (handles multi-field value_types).
 *
 * This is a wrapper around expandField that flattens multi-field expansions.
 */
function expandFields(
  fields: ReadonlyArray<Record<string, unknown>>,
  ir: IR,
  enums: Map<string, ReadonlyArray<string>>,
): PhysicalColumn[] {
  const columns: PhysicalColumn[] = [];
  for (const f of fields) {
    const expanded = expandField(f, ir, enums);
    columns.push(...expanded);
  }
  return columns;
}

function expandField(
  f: Record<string, unknown>,
  ir: IR,
  enums: Map<string, ReadonlyArray<string>>,
): PhysicalColumn[] {
  const fName = String(f.name);
  const desc = descriptorOf(f);
  const ref = desc.ref;

  // After link, every ref is a fully-qualified name (sys.mod.declaredName) —
  // short names were resolved against the using namespace and rewritten.
  // Identity == declared-name fqn (parse corrects it from the file's `name:`),
  // so the ref IS the identity body. Look up the node and branch by its FORM
  // (scalar/struct/enum). This is the unified projection rule (design note §4.4).
  const targetId = `type:${ref}`;
  const vtNode = ir.nodes.get(targetId);
  if (!vtNode) {
    throw new Error(`Type node not found: ${targetId}`);
  }
  if (vtNode.kind !== 'type') {
    throw new Error(`Expected type, got ${vtNode.kind} for ${targetId}`);
  }

  const vt = vtNode.data as TypeNode;

  // form: scalar → one column, dialect keyed by the scalar's declared name.
  if (vt.form === 'scalar') {
    const result: PhysicalColumn = {
      name: fName,
      scalar: vt.name,
      required: f.required === true,
      unique: f.unique === true,
      props: desc.args ?? {},
    };
    return [result];
  }

  // form: enum → single column backed by the enum registry. The column's
  // scalar is 'string' for dialect purposes; enumRef drives PG ENUM /
  // MySQL ENUM / SQLite CHECK.
  if (vt.form === 'enum') {
    const result: PhysicalColumn = {
      name: fName,
      scalar: 'string',
      required: f.required === true,
      unique: f.unique === true,
      props: {},
      enumRef: targetId,
    };
    return [result];
  }

  // form: struct → fields-based expansion below.
  // Generic instantiation: if the struct declares type_parameters and the
  // caller passed args binding them, substitute each field's type ref that
  // names a type parameter with the caller-supplied (or defaulted) type.
  const typeParams = (
    vt as unknown as { type_parameters?: Array<{ name: string; default?: string }> }
  ).type_parameters;
  const callerArgs = desc.args ?? {};
  let fields = vt.fields as ReadonlyArray<Record<string, unknown>>;
  if (typeParams && typeParams.length > 0) {
    fields = instantiateFields(fields, typeParams, callerArgs);
  }

  const vtNodeForField = {
    kind: 'type' as const,
    name: vt.name,
    fields: fields as ValueTypeNode['fields'],
  };

  if (isSingleFieldValueType(vtNodeForField)) {
    const inner = fields[0] as Record<string, unknown>;
    const innerDesc = descriptorOf(inner);
    const scalar = scalarNameOf(innerDesc.ref, ir);
    const props = innerDesc.args ?? {};
    let enumRef: string | undefined;
    if (scalar === 'enum' && Array.isArray(props.values)) {
      enumRef = targetId;
    }
    const result: PhysicalColumn = {
      name: fName,
      scalar,
      required: f.required === true,
      unique: f.unique === true,
      props,
      ...(enumRef !== undefined ? { enumRef } : {}),
    };
    return [result];
  }

  // Multi-field struct: one column per subfield.
  const expanded = expandValueColumns(fName, vtNodeForField);
  return expanded.map((col, idx) => {
    const subField = fields[idx] as Record<string, unknown>;
    const subDesc = descriptorOf(subField);
    const subType = scalarNameOf(subDesc.ref, ir);
    const subProps = subDesc.args ?? {};
    const result: PhysicalColumn = {
      name: col.name,
      scalar: subType,
      required: f.required === true,
      unique: f.unique === true,
      props: subProps,
      ...(subType === 'enum' && Array.isArray(subProps.values) ? { enumRef: targetId } : {}),
    };
    return result;
  });
}

/**
 * Collect variant values from value_types with a top-level `variants:` list.
 *
 * Populates the `enums` registry: identity → values array. Each variant's
 * `value` (the shorthand string, or the detailed object's `value` field)
 * becomes one entry. This registry feeds the dialect projectors (PG enum
 * types, MySQL ENUM, SQLite CHECK).
 */
function collectEnums(ir: IR, enums: Map<string, ReadonlyArray<string>>): void {
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'type') continue;
    const vt = node.data as TypeNode;
    const variants = (vt as unknown as { variants?: ReadonlyArray<unknown> }).variants;
    if (!variants || variants.length === 0) continue;
    const values = variants.map((v) =>
      typeof v === 'string' ? v : (v as { value: string }).value,
    );
    enums.set(identity, values);
  }
}
