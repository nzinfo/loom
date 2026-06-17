/**
 * Design → Physical model projector. See spec §6, §8, §11, §7.5.
 *
 * Expands design-level constructs (mixins, value_types, extension_fields)
 * into physical columns, tables, and registries.
 *
 * This is the core of the Loom projection engine.
 */

import type { IR, IRNode } from '../ir/version.js';
import type { Table, ValueType, ExtensionFields } from '../ir/schemas.js';
import type {
  PhysicalModel,
  PhysicalTable,
  PhysicalColumn,
  PhysicalIndex,
  PhysicalForeignKey,
  ExtensionFieldEntry,
} from './types.js';
import { isSingleFieldValueType, expandValueColumns, type ValueTypeNode } from '../ir/field.js';

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
  const extensionFields = new Map<string, ReadonlyArray<ExtensionFieldEntry>>();

  // Collect enums and extension_fields first (they're referenced elsewhere).
  collectEnums(ir, enums);
  collectExtensionFields(ir, extensionFields);

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
  // Path format: systems/<system>/<module>/table/<name>.yaml
  const parts = node.file.split('/');
  const system = parts[1];
  const module = parts[2];
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
      const mixinFields = resolveFields(mixinNode.data.fields as ReadonlyArray<Record<string, unknown>>, ir);
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

/**
 * Expand a single field into one or more PhysicalColumns.
 *
 * - Base fields: expand to 1 column (or N if the base is a value_type with multiple fields).
 * - Ref fields to value_types: expand to 1 or N columns based on the value_type.
 * - Ref fields to other kinds (not currently handled).
 *
 * Also records enumRef for single-field enum value_types.
 */
function expandField(
  f: Record<string, unknown>,
  ir: IR,
  enums: Map<string, ReadonlyArray<string>>,
): PhysicalColumn[] {
  const fName = String(f.name);
  let scalar: string;
  let props: Record<string, unknown> = {};
  let enumRef: string | undefined;

  if ('base' in f) {
    // Direct base scalar (e.g., bigint, string).
    scalar = String(f.base);
    props = extractProperties(f);
  } else if ('ref' in f) {
    // Reference to a value_type or other construct.
    const ref = String(f.ref);
    if (!ref.startsWith('value_type:')) {
      throw new Error(`Only value_type refs are supported in field expansion, got ${ref}`);
    }
    const vtNode = ir.nodes.get(ref);
    if (!vtNode) {
      throw new Error(`Value type not found: ${ref}`);
    }
    if (vtNode.kind !== 'value_type') {
      throw new Error(`Expected value_type, got ${vtNode.kind}`);
    }

    const vt = vtNode.data as ValueType;
    const vtNodeForField = vt as unknown as ValueTypeNode;

    // For single-field value_types, expose the inner field's base.
    if (isSingleFieldValueType(vtNodeForField)) {
      const inner = vt.fields[0] as Record<string, unknown>;
      scalar = String(inner.base);
      props = extractProperties(inner);
      // If the inner field is an enum, record the reference.
      if (scalar === 'enum' && 'values' in inner) {
        const values = inner.values;
        if (Array.isArray(values)) {
          enumRef = ref; // The value_type identity.
        }
      }
    } else {
      // Multi-field value_type: create a column for each sub-field.
      const expanded = expandValueColumns(fName, vtNodeForField);
      return expanded.map((col, idx) => {
        // Find the corresponding sub-field to get its base and properties.
        const subField = vt.fields[idx] as Record<string, unknown>;
        const result: PhysicalColumn = {
          name: col.name,
          scalar: String(subField.base),
          required: f.required === true,
          unique: f.unique === true,
          props: extractProperties(subField),
          ...(subField.base === 'enum' && Array.isArray(subField.values) ? { enumRef: ref } : {}),
        };
        return result;
      });
    }
  } else {
    throw new Error(`Field must have 'base' or 'ref': ${JSON.stringify(f)}`);
  }

  // Single-field case (base or single-field value_type ref).
  const result: PhysicalColumn = {
    name: fName,
    scalar,
    required: f.required === true,
    unique: f.unique === true,
    props,
    ...(enumRef !== undefined ? { enumRef: enumRef } : {}),
  };
  return [result];
}

/**
 * Extract scalar properties from a field object (e.g., max_length, precision, scale).
 *
 * Skips known structural keys like 'name', 'base', 'ref', 'required', 'unique', 'default', 'include'.
 */
function extractProperties(field: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const skipKeys = new Set(['name', 'base', 'ref', 'required', 'unique', 'default', 'include', 'default_scope']);

  for (const [k, v] of Object.entries(field)) {
    if (!skipKeys.has(k)) {
      props[k] = v;
    }
  }

  return props;
}

/**
 * Collect enum values from value_types with base='enum'.
 *
 * Populates the `enums` registry: identity → values array.
 */
function collectEnums(ir: IR, enums: Map<string, ReadonlyArray<string>>): void {
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'value_type') continue;

    const vt = node.data as ValueType;
    // Check if the first field has base='enum'.
    if (vt.fields.length === 1) {
      const first = vt.fields[0] as Record<string, unknown>;
      if (first.base === 'enum' && Array.isArray(first.values)) {
        enums.set(identity, first.values as ReadonlyArray<string>);
      }
    }
  }
}

/**
 * Collect extension_fields into the registry.
 *
 * Populates the `extensionFields` registry: entity identity → ExtensionFieldEntry array.
 */
function collectExtensionFields(
  ir: IR,
  extensionFields: Map<string, ReadonlyArray<ExtensionFieldEntry>>,
): void {
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'extension_fields') continue;

    const ef = node.data as ExtensionFields;
    const entityRef = ef.entity;
    const entries: ExtensionFieldEntry[] = [];

    for (const f of ef.fields as ReadonlyArray<Record<string, unknown>>) {
      const fRec = f as Record<string, unknown>;

      // Skip include entries (they're handled at parse time)
      if ('include' in fRec) continue;

      // Handle ref fields
      if ('ref' in fRec) {
        const entry: ExtensionFieldEntry = {
          name: String(fRec.name),
          scalar: '',
          refValueTypeId: String(fRec.ref),
          props: extractProperties(fRec),
          ...(fRec.default_scope !== undefined ? { defaultScope: String(fRec.default_scope) } : {}),
        };
        entries.push(entry);
      } else if ('base' in fRec) {
        const entry: ExtensionFieldEntry = {
          name: String(fRec.name),
          scalar: String(fRec.base),
          props: extractProperties(fRec),
          ...(fRec.default_scope !== undefined ? { defaultScope: String(fRec.default_scope) } : {}),
        };
        entries.push(entry);
      } else {
        throw new Error(`Extension field must have 'base' or 'ref': ${JSON.stringify(fRec)}`);
      }
    }

    extensionFields.set(entityRef, entries);
  }
}
