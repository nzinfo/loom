/**
 * Design → Physical model projector. See spec §6, §8, §11, §7.5.
 *
 * Expands design-level constructs (mixins, value_types, extension_fields)
 * into physical columns, tables, and registries.
 *
 * This is the core of the Loom projection engine.
 */

import { type ValueTypeNode, expandValueColumns, isSingleFieldValueType } from '../ir/field.js';
import type { ExtensionFields, Table, TypeDescriptor, ValueType } from '../ir/schemas.js';
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

  // Three-segment: value_type reference. Link pass verified existence + kind
  // and rewrote short-name matches to their fqn, so ref is `sys.mod.Name`.
  const targetId = `value_type:${ref}`;
  const vtNode = ir.nodes.get(targetId);
  if (!vtNode) {
    throw new Error(`Value type not found: ${targetId}`);
  }
  if (vtNode.kind !== 'value_type') {
    throw new Error(`Expected value_type, got ${vtNode.kind} for ${targetId}`);
  }

  const vt = vtNode.data as ValueType;
  const vtNodeForField = vt as unknown as ValueTypeNode;

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
    const inner = vt.fields[0] as Record<string, unknown>;
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
    const subField = vt.fields[idx] as Record<string, unknown>;
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
    if (node.kind !== 'value_type') continue;
    const vt = node.data as ValueType;
    const variants = (vt as unknown as { variants?: ReadonlyArray<unknown> }).variants;
    if (!variants || variants.length === 0) continue;
    const values = variants.map((v) =>
      typeof v === 'string' ? v : (v as { value: string }).value,
    );
    enums.set(identity, values);
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

      const desc = descriptorOf(fRec);
      const ref = desc.ref;
      if (ref.includes('.')) {
        const entry: ExtensionFieldEntry = {
          name: String(fRec.name),
          scalar: '',
          refValueTypeId: `value_type:${ref}`,
          props: desc.args ?? {},
          ...(fRec.default_scope !== undefined ? { defaultScope: String(fRec.default_scope) } : {}),
        };
        entries.push(entry);
      } else {
        const entry: ExtensionFieldEntry = {
          name: String(fRec.name),
          scalar: ref,
          props: desc.args ?? {},
          ...(fRec.default_scope !== undefined ? { defaultScope: String(fRec.default_scope) } : {}),
        };
        entries.push(entry);
      }
    }

    extensionFields.set(entityRef, entries);
  }
}
