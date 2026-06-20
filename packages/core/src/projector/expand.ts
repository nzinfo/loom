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
export function expandTables(ir: IR): PhysicalModel {
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

    const table = expandTable(node, ir, enums, extensionFields);
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
): PhysicalTable {
  const { data } = node;
  const tableName = data.table.name;
  const strategy = data.table.extension.strategy;
  const schema = extractPhysicalSchema(node, ir);
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
 * Extract the physical_schema from the table's module_manifest.
 *
 * The manifest is at `systems/<system>/<module>/MANIFEST.yaml`.
 * This function walks up the path to find it.
 */
function extractPhysicalSchema(node: IRNode & { kind: 'table' }, ir: IR): string {
  // Identity format: table:<system>.<module>.<Name>
  const identityParts = node.identity.split(':');
  const qualifiedName = identityParts[1]; // <system>.<module>.<Name>
  const parts = (qualifiedName ?? '').split('.');
  const system = parts[0] ?? '';
  const module = parts[1] ?? '';
  const manifestIdentity = `module_manifest:${system}.${module}`;
  const manifestNode = ir.nodes.get(manifestIdentity);

  if (!manifestNode) {
    throw new Error(`Missing module_manifest for table ${node.identity}`);
  }

  if (manifestNode.kind !== 'module_manifest') {
    throw new Error(`Expected module_manifest, got ${manifestNode.kind}`);
  }

  return manifestNode.data.physical_schema;
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

  // Single-segment: direct base_types scalar.
  if (!ref.includes('.')) {
    const result: PhysicalColumn = {
      name: fName,
      scalar: ref,
      required: f.required === true,
      unique: f.unique === true,
      props: desc.args ?? {},
    };
    return [result];
  }

  // Three-segment: type reference. Link pass verified existence + kind
  // and rewrote short-name matches to their fqn, so ref is `sys.mod.Name`.
  const targetId = `type:${ref}`;
  const vtNode = ir.nodes.get(targetId);
  if (!vtNode) {
    throw new Error(`Type node not found: ${targetId}`);
  }
  if (vtNode.kind !== 'type') {
    throw new Error(`Expected type, got ${vtNode.kind} for ${targetId}`);
  }

  const vt = vtNode.data as TypeNode;

  // Generic instantiation: if the value_type declares type_parameters and
  // the caller passed args binding them, substitute each field's type ref
  // that names a type parameter with the caller-supplied (or defaulted) type.
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

  // Variants form (sum type): render as a single column backed by the
  // enum registry. The column's scalar is reported as 'string' for dialect
  // purposes; the enumRef drives PG ENUM / MySQL ENUM / SQLite CHECK.
  const variants = (vt as unknown as { variants?: ReadonlyArray<unknown> }).variants;
  if (variants && variants.length > 0) {
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

  if (isSingleFieldValueType(vtNodeForField)) {
    const inner = fields[0] as Record<string, unknown>;
    const innerDesc = descriptorOf(inner);
    const scalar = innerDesc.ref;
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

  // Multi-field value_type: one column per subfield.
  const expanded = expandValueColumns(fName, vtNodeForField);
  return expanded.map((col, idx) => {
    const subField = fields[idx] as Record<string, unknown>;
    const subDesc = descriptorOf(subField);
    const subType = subDesc.ref;
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
