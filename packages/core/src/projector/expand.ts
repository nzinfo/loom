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
import type { EnumVariant } from './enumMeta.js';
import type {
  EnumEntry,
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

/** True if the ref points to an enum-form type node. */
function isEnumRef(ref: string, ir: IR): boolean {
  const node = ir.nodes.get(`type:${ref}`);
  return node?.kind === 'type' && (node.data as TypeNode).form === 'enum';
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
  const extTables: PhysicalTable[] = [];
  const enums = new Map<string, EnumEntry>();
  // extension_fields were aggregated by the link pass into ir.extensionFields.
  // Copy them verbatim into the physical model (spec §7).
  const extensionFields = new Map<string, ReadonlyArray<ExtensionFieldEntry>>(ir.extensionFields);

  // Collect enums first (referenced during table expansion).
  collectEnums(ir, enums);

  // Build a table-identity → entity-view-name map so tables can look up
  // their entity's declared view name (the view is an entity-level concern,
  // not a table-level one).
  const tableToView = new Map<string, string | undefined>();
  for (const [, node] of ir.nodes) {
    if (node.kind !== 'entity') continue;
    const entityData = node.data as { primary_table?: string; view?: string };
    if (entityData.primary_table !== undefined) {
      tableToView.set(entityData.primary_table, entityData.view);
    }
  }

  // Expand each table node.
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'table') continue;

    const table = expandTable(
      node,
      ir,
      enums,
      extensionFields,
      physicalSchemaOverrides,
      tableToView,
      extTables,
    );
    tables.push(table);
  }

  // Append new_table ext tables after base tables.
  tables.push(...extTables);

  return { tables, enums, extensionFields };
}

/**
 * Expand a single table IR node into a PhysicalTable.
 *
 * Handles mixin expansion, value_type expansion, extension strategy,
 * and schema qualification. Also collects new_table extensions into
 * separate PhysicalTable entries (returned via the extTables output param).
 */
function expandTable(
  node: IRNode & { kind: 'table'; data: Table },
  ir: IR,
  enums: Map<string, EnumEntry>,
  extensionFields: Map<string, ReadonlyArray<ExtensionFieldEntry>>,
  physicalSchemaOverrides?: ReadonlyMap<string, string>,
  tableToView?: ReadonlyMap<string, string | undefined>,
  extTablesOutput?: PhysicalTable[],
): PhysicalTable {
  const { data } = node;
  const tableName = data.table.name;

  // Resolve strategy: new extensible API takes precedence over legacy extension.
  const extensible = data.extensible === true;
  const legacyStrategy = data.extension?.strategy ?? 'none';
  const strategy = extensible ? 'sidecar_jsonb' : legacyStrategy;

  // physical_schema derives from <system>_<module>; CLI overrides may replace it.
  const identityBody = node.identity.slice('table:'.length); // <system>.<module>.<Name>
  const dot2 = identityBody.lastIndexOf('.');
  const dot1 = identityBody.lastIndexOf('.', dot2 - 1);
  const system = dot1 >= 0 ? identityBody.slice(0, dot1) : '';
  const module = dot1 >= 0 ? identityBody.slice(dot1 + 1, dot2) : '';
  const schema = physicalSchemaOf(system, module, physicalSchemaOverrides);
  const qualifiedName = `${schema}.${tableName}`;

  // Resolve all fields (including mixin includes).
  const fields = data.fields;

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

  // Resolve sidecar ext table name: ext-declared > table's default_ext_table > legacy ext_table > auto-derive.
  const defaultExtTable =
    data.default_ext_table ?? data.extension?.ext_table ?? `${tableName}_ext`;
  const view = tableToView?.get(node.identity);

  // Process extensions for this table's entity.
  // Single entity lookup used for both new_table ext collection and sidecar name resolution.
  const entityIdForTable = findEntityForTable(ir, node.identity);
  const extEntries = entityIdForTable ? extensionFields.get(entityIdForTable) : undefined;

  // Process new_table extensions — generate separate PhysicalTable entries.
  if (extEntries) {
    const newTableExts = collectNewTableExts(
      extEntries,
      data,
      ir,
      enums,
      schema,
      qualifiedName,
    );
    if (extTablesOutput && newTableExts.length > 0) {
      extTablesOutput.push(...newTableExts);
    }
  }

  // Resolve sidecar ext table name from ext entries (first sidecar ext that declares a table wins).
  let sidecarExtTable: string | undefined;
  if (strategy === 'sidecar_jsonb' || strategy === 'sidecar_eav') {
    if (extEntries) {
      const sidecarExt = extEntries.find(
        (e) => e.strategy === 'sidecar_jsonb' && e.tableName !== '',
      );
      sidecarExtTable = sidecarExt?.tableName ?? defaultExtTable;
    } else {
      sidecarExtTable = defaultExtTable;
    }
  }

  const base: PhysicalTable = {
    name: tableName,
    schema,
    qualifiedName,
    columns,
    primaryKey: data.primary_key,
    indexes,
    foreignKeys,
    strategy,
    ...(sidecarExtTable ? { extTableName: sidecarExtTable } : {}),
    ...(view ? { viewName: view } : {}),
    ...(sidecarExtTable ? { sidecarPkColumns: data.primary_key } : {}),
  };

  return base;
}

/** Find the entity identity that points to this table as its primary_table. */
function findEntityForTable(ir: IR, tableIdentity: string): string | undefined {
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'entity') continue;
    const entityData = node.data as { primary_table?: string };
    if (entityData.primary_table === tableIdentity) {
      return identity;
    }
  }
  return undefined;
}

/** Collect new_table extensions and build PhysicalTable entries for each.
 * FK columns are auto-injected from the base table's primary_key (same names/types). */
function collectNewTableExts(
  extEntries: ReadonlyArray<ExtensionFieldEntry>,
  baseTable: Table,
  ir: IR,
  enums: Map<string, EnumEntry>,
  schema: string | undefined,
  baseQualifiedName: string,
): PhysicalTable[] {
  const result: PhysicalTable[] = [];

  // Group new_table exts by tableName (one PhysicalTable per ext table).
  const byTableName = new Map<string, ExtensionFieldEntry[]>();
  for (const ext of extEntries) {
    if (ext.strategy !== 'new_table') continue;
    const tbl = ext.tableName;
    // tableName empty → validate should have caught this; skip defensively.
    if (!tbl) continue;
    let bucket = byTableName.get(tbl);
    if (!bucket) {
      bucket = [];
      byTableName.set(tbl, bucket);
    }
    bucket.push(ext);
  }

  // Build FK columns from base table's primary_key.
  const pkColumns = baseTable.primary_key;
  const pkTypes = pkColumns.map((pkName) => {
    const field = baseTable.fields.find((f) => String(f.name) === pkName);
    return field ? descriptorOf(field) : null;
  });

  for (const [extTableName, entries] of byTableName) {
    // Auto-inject FK columns at head (reuse base PK column names).
    const fkColumns: PhysicalColumn[] = [];
    for (let i = 0; i < pkColumns.length; i++) {
      const pkName = pkColumns[i]!;
      const pkDesc = pkTypes[i];
      // Resolve PK scalar name for dialect.
      const pkScalar = pkDesc ? scalarNameOf(pkDesc.ref, ir) : 'string';
      fkColumns.push({
        name: pkName,
        scalar: pkScalar,
        required: true,
        unique: false,
        props: pkDesc?.args ?? {},
      });
    }

    // Expand ext data fields into columns.
    // Ext entries carry a resolved scalar name (short form like 'string',
    // 'bigint') and optional props. Build PhysicalColumn directly — no need
    // for expandField's type-node lookup (the ext entry already resolved types
    // during link).
    const dataColumns: PhysicalColumn[] = [];
    const injectedNames = new Set(pkColumns);
    for (const ext of entries) {
      if (injectedNames.has(ext.name)) continue; // collision with FK column

      if (ext.refValueTypeId) {
        // Struct ref — expand sub-fields via type node lookup.
        const vtNode = ir.nodes.get(ext.refValueTypeId);
        if (vtNode?.kind === 'type') {
          const vt = vtNode.data as TypeNode;
          if (vt.form === 'struct') {
            const fields = vt.fields as ReadonlyArray<Record<string, unknown>>;
            const vtNodeForField = {
              kind: 'type' as const,
              name: vt.name,
              fields: fields as ValueTypeNode['fields'],
            };
            const expanded = expandValueColumns(ext.name, vtNodeForField);
            for (let idx = 0; idx < expanded.length; idx++) {
              const col = expanded[idx]!;
              if (injectedNames.has(col.name)) continue;
              const subField = fields[idx] as Record<string, unknown>;
              const subDesc = descriptorOf(subField);
              const subScalar = scalarNameOf(subDesc.ref, ir);
              dataColumns.push({
                name: col.name,
                scalar: subScalar,
                required: false,
                unique: false,
                props: subDesc.args ?? {},
              });
            }
          } else if (vt.form === 'enum') {
            dataColumns.push({
              name: ext.name,
              scalar: 'string',
              required: false,
              unique: false,
              props: {},
              enumRef: ext.refValueTypeId,
            });
          } else {
            // scalar ref via type node
            dataColumns.push({
              name: ext.name,
              scalar: vt.name,
              required: false,
              unique: false,
              props: ext.props,
            });
          }
        }
      } else {
        // Direct scalar — use the resolved short name.
        dataColumns.push({
          name: ext.name,
          scalar: ext.scalar,
          required: false,
          unique: false,
          props: ext.props,
        });
      }
    }

    const extSchema = schema;
    const extQual = `${extSchema}.${extTableName}`;

    // FK constraint: injected columns reference base table PK.
    const extForeignKey: PhysicalForeignKey = {
      name: `fk_${extTableName}_base`,
      columns: pkColumns,
      refTable: baseQualifiedName,
      refColumns: pkColumns,
    };

    result.push({
      name: extTableName,
      schema: extSchema,
      qualifiedName: extQual,
      columns: [...fkColumns, ...dataColumns],
      primaryKey: pkColumns,
      indexes: [],
      foreignKeys: [extForeignKey],
      strategy: 'new_table',
    });
  }

  return result;
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
 * Expand multiple fields into columns (handles multi-field value_types).
 *
 * This is a wrapper around expandField that flattens multi-field expansions.
 */
function expandFields(
  fields: ReadonlyArray<Record<string, unknown>>,
  ir: IR,
  enums: Map<string, EnumEntry>,
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
  enums: Map<string, EnumEntry>,
): PhysicalColumn[] {
  const fName = String(f.name);
  const desc = descriptorOf(f);
  const ref = desc.ref;
  // column: default = field name; '' (empty) = flatten (no prefix); other = override.
  const fColumn = typeof f.column === 'string' ? f.column : fName;
  const isFlatten = fColumn === '';

  // After link, every ref is a fully-qualified name (sys.mod.declaredName) —
  // short names were resolved against the using namespace and rewritten.
  // Identity == declared-name fqn (parse corrects it from the file's `name:`),
  // so the ref IS the identity body. Look up the node and branch by its FORM
  // (scalar/struct/enum). This is the unified projection rule (design note §4.4).
  const targetId = `type:${ref}`;
  const vtNode = ir.nodes.get(targetId);
  if (!vtNode || vtNode.kind !== 'type') {
    // This should have been caught by validate. Return empty rather
    // than crashing — the missing type will show as absent columns.
    return [];
  }

  const vt = vtNode.data as TypeNode;

  // form: scalar → one column, dialect keyed by the scalar's declared name.
  if (vt.form === 'scalar') {
    const result: PhysicalColumn = {
      name: fColumn,
      scalar: vt.name,
      required: f.required === true,
      unique: f.unique === true,
      props: desc.args ?? {},
    };
    return [result];
  }

  // form: enum → single column backed by the enum registry. The column's
  // scalar is the enum's carrier type (default 'string'); enumRef drives
  // native ENUM (string carrier) or CHECK constraint (integer carrier).
  if (vt.form === 'enum') {
    const carrier = (vt as TypeNode & { carrier?: string }).carrier ?? 'string';
    const result: PhysicalColumn = {
      name: fColumn,
      scalar: carrier,
      required: f.required === true,
      unique: f.unique === true,
      props: {},
      enumRef: targetId,
    };
    return [result];
  }

  // form: struct → fields-based expansion below.
  const fields = vt.fields as ReadonlyArray<Record<string, unknown>>;

  const vtNodeForField = {
    kind: 'type' as const,
    name: vt.name,
    fields: fields as ValueTypeNode['fields'],
  };

  if (isSingleFieldValueType(vtNodeForField)) {
    const inner = fields[0] as Record<string, unknown>;
    const innerDesc = descriptorOf(inner);
    const scalar = scalarNameOf(innerDesc.ref, ir);
    // newtype: constraint belongs to the type definition — use the inner
    // field's declared args verbatim (caller args on a struct ref are ignored).
    const props = innerDesc.args ?? {};
    let enumRef: string | undefined;
    if (isEnumRef(innerDesc.ref, ir)) {
      enumRef = `type:${innerDesc.ref}`;
    }
    const result: PhysicalColumn = {
      name: fColumn,
      scalar,
      required: f.required === true,
      unique: f.unique === true,
      props,
      ...(enumRef !== undefined ? { enumRef } : {}),
    };
    return [result];
  }

  // Multi-field struct: one column per subfield.
  // fColumn is the prefix (default = field name); '' = flatten (use subfield names directly).
  const prefix = isFlatten ? '' : fColumn;
  const expanded = expandValueColumns(prefix, vtNodeForField);
  return expanded.map((col, idx) => {
    const subField = fields[idx] as Record<string, unknown>;
    const subDesc = descriptorOf(subField);
    const subType = scalarNameOf(subDesc.ref, ir);
    const subProps = subDesc.args ?? {};
    // For flatten (column: ''), each subfield's own required/unique wins
    // (mixin semantics: the struct's fields are inserted as-is). For
    // prefix mode, the outer field's required/unique applies to all sub-columns.
    const required = isFlatten ? subField.required === true : f.required === true;
    const unique = isFlatten ? subField.unique === true : f.unique === true;
    const result: PhysicalColumn = {
      name: col.name,
      scalar: subType,
      required,
      unique,
      props: subProps,
      ...(isEnumRef(subDesc.ref, ir) ? { enumRef: `type:${subDesc.ref}` } : {}),
    };
    return result;
  });
}

/**
 * Collect variants from type nodes with `form: 'enum'`.
 *
 * Populates the `enums` registry: identity → EnumEntry (carrier + variants).
 * Each variant is normalized: a bare string/number becomes `{ value }`;
 * the detailed object form keeps its optional `display_name`/`description`.
 * This registry feeds the dialect projectors — they read `.carrier` to decide
 * between native ENUM (string) and integer column + CHECK, and `.variants`
 * for the value list.
 */
function collectEnums(ir: IR, enums: Map<string, EnumEntry>): void {
  for (const [identity, node] of ir.nodes) {
    if (node.kind !== 'type') continue;
    const vt = node.data as TypeNode;
    if (vt.form !== 'enum') continue;
    const variants = (vt as unknown as { variants?: ReadonlyArray<unknown> }).variants;
    if (!variants || variants.length === 0) continue;
    const carrier = (vt as TypeNode & { carrier?: string }).carrier ?? 'string';
    const normalized = variants.map((v): EnumVariant => {
      if (typeof v === 'string' || typeof v === 'number') return { value: v };
      const obj = v as { value: string | number; display_name?: string; description?: string };
      return {
        value: obj.value,
        ...(obj.display_name !== undefined ? { display_name: obj.display_name } : {}),
        ...(obj.description !== undefined ? { description: obj.description } : {}),
      };
    });
    enums.set(identity, { carrier, variants: normalized });
  }
}
