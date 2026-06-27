/**
 * Physical model → JSON serializer.
 *
 * Produces the JSON structure documented in docs/project-model-schema.md.
 * Consumed by external tools (ORM generators, atlas bridge, doc tools).
 *
 * The scalar→SQL type mapping mirrors the dialect projectors in @loom/core,
 * but is implemented independently here because the dialect type functions
 * are not exported (they're internal to the SQL emission path).
 */
import { scalarToSql } from '@loom/core';
import type {
  Dialect,
  EnumVariant,
  ExtensionFieldEntry,
  IR,
  PhysicalColumn,
  PhysicalModel,
} from '@loom/core';
import type { TypeNode } from '@loom/core';

export interface ModelJson {
  readonly version: string;
  readonly dialect: string;
  readonly tables: readonly TableJson[];
  readonly enums: readonly EnumJson[];
  readonly extensions: readonly ExtensionJson[];
}

interface TableJson {
  readonly name: string;
  readonly schema: string;
  readonly qualifiedName: string;
  readonly columns: readonly ColumnJson[];
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexJson[];
  readonly foreignKeys: readonly ForeignKeyJson[];
  readonly extension?: ExtMetaJson;
}

interface ExtMetaJson {
  readonly strategy: string;
  readonly extTable?: string;
  readonly view?: string;
}

interface ColumnJson {
  readonly name: string;
  readonly sqlType: string;
  readonly scalar: string;
  readonly props: Record<string, unknown>;
  readonly required: boolean;
  readonly unique: boolean;
  readonly enumRef: string | null;
}

interface IndexJson {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

interface ForeignKeyJson {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete?: string;
}

interface EnumVariantJson {
  readonly value: string | number;
  readonly display_name?: string;
  readonly description?: string;
}

interface EnumJson {
  readonly identity: string;
  readonly name: string;
  /** Underlying storage scalar (e.g. 'string', 'uint8'). */
  readonly carrier: string;
  /** Bare value list (backward compatible). */
  readonly values: readonly (string | number)[];
  /** Variants with optional metadata (display_name/description) for downstream
   * consumers (UI labels, docs, reverse-engineering). Mirrors the structured
   * `loom:enum` comment emitted into DDL. */
  readonly variants: readonly EnumVariantJson[];
}

interface ExtensionJson {
  readonly entity: string;
  readonly groups: readonly GroupJson[];
}

interface GroupJson {
  readonly name: string;
  readonly owner: string;
  readonly fields: readonly ExtFieldJson[];
}

interface ExtFieldJson {
  readonly name: string;
  readonly scalar: string | null;
  readonly refType?: string;
  readonly props: Record<string, unknown>;
  readonly sqlType?: string;
  readonly expandedFields?: ExpandedFieldJson[];
}

interface ExpandedFieldJson {
  readonly name: string;
  readonly scalar: string;
  readonly sqlType: string;
}

export function projectModelJson(ir: IR, model: PhysicalModel, dialect: Dialect): ModelJson {
  return {
    version: 'loom-schema/v2',
    dialect,
    tables: model.tables.map((t) => serializeTable(t, dialect, model.enums)),
    enums: serializeEnums(model),
    extensions: serializeExtensions(ir, model, dialect),
  };
}

function serializeTable(t: PhysicalModel['tables'][number], dialect: Dialect, enums: PhysicalModel['enums']): TableJson {
  const extension =
    t.strategy !== 'none'
      ? {
          strategy: t.strategy,
          ...(t.extTableName ? { extTable: t.extTableName } : {}),
          ...(t.viewName ? { view: t.viewName } : {}),
        }
      : undefined;

  return {
    name: t.name,
    schema: t.schema ?? '',
    qualifiedName: t.qualifiedName,
    columns: t.columns.map((c) => serializeColumn(c, dialect, enums)),
    primaryKey: t.primaryKey,
    indexes: t.indexes.map((i) => ({
      name: i.name,
      columns: i.columns,
      unique: i.unique,
    })),
    foreignKeys: t.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: fk.columns,
      refTable: fk.refTable,
      refColumns: fk.refColumns,
      ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
    })),
    ...(extension ? { extension } : {}),
  };
}

function serializeColumn(c: PhysicalColumn, dialect: Dialect, enums: PhysicalModel['enums']): ColumnJson {
  let sqlType: string;
  if (c.enumRef) {
    const entry = enums.get(c.enumRef);
    if (entry && entry.carrier !== 'string') {
      // Integer-backed enum: output the actual scalar SQL type.
      sqlType = scalarToSql(entry.carrier, c.props as Record<string, unknown>, dialect);
    } else {
      // String-backed enum: keep backward-compatible behavior (enum identity).
      // External tools use this to find the enum in the `enums` registry.
      sqlType = c.enumRef;
    }
  } else {
    sqlType = scalarToSql(c.scalar, c.props as Record<string, unknown>, dialect);
  }
  return {
    name: c.name,
    sqlType,
    scalar: c.scalar,
    props: c.props as Record<string, unknown>,
    required: c.required,
    unique: c.unique,
    enumRef: c.enumRef ?? null,
  };
}

function serializeEnums(model: PhysicalModel): EnumJson[] {
  const out: EnumJson[] = [];
  for (const [identity, entry] of model.enums) {
    const colonIdx = identity.indexOf(':');
    const body = identity.slice(colonIdx + 1);
    const lastDot = body.lastIndexOf('.');
    const name = lastDot >= 0 ? body.slice(lastDot + 1) : body;
    out.push({
      identity,
      name,
      carrier: entry.carrier,
      values: entry.variants.map((v) => v.value),
      variants: entry.variants.map((v) => serializeVariant(v)),
    });
  }
  return out;
}

function serializeVariant(v: EnumVariant): EnumVariantJson {
  return {
    value: v.value,
    ...(v.display_name !== undefined ? { display_name: v.display_name } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
  };
}

function serializeExtensions(ir: IR, model: PhysicalModel, dialect: Dialect): ExtensionJson[] {
  const out: ExtensionJson[] = [];
  for (const [entity, entries] of model.extensionFields) {
    // Group entries by group name, preserving first-seen order.
    const groupOrder: string[] = [];
    const byGroup = new Map<string, ExtensionFieldEntry[]>();
    for (const ef of entries) {
      let bucket = byGroup.get(ef.group);
      if (bucket === undefined) {
        bucket = [];
        byGroup.set(ef.group, bucket);
        groupOrder.push(ef.group);
      }
      bucket.push(ef);
    }

    const groups: GroupJson[] = groupOrder.map((groupName) => {
      const fields = byGroup.get(groupName) ?? [];
      const ownerStr = fields[0] ? formatOwner(fields[0].owner) : 'unknown';
      return {
        name: groupName,
        owner: ownerStr,
        fields: fields.map((ef) => serializeExtField(ef, ir, dialect)),
      };
    });

    out.push({ entity, groups });
  }
  return out;
}

function serializeExtField(ef: ExtensionFieldEntry, ir: IR, dialect: Dialect): ExtFieldJson {
  if (ef.refValueTypeId) {
    // Struct/enum ref — expand sub-fields.
    const node = ir.nodes.get(ef.refValueTypeId);
    if (node?.kind === 'type') {
      const tn = node.data as TypeNode;
      const fields = (tn as unknown as { fields?: ReadonlyArray<Record<string, unknown>> }).fields;
      if (fields && fields.length > 0) {
        return {
          name: ef.name,
          scalar: null,
          refType: ef.refValueTypeId,
          props: ef.props as Record<string, unknown>,
          expandedFields: fields.map((f) => {
            const subName = f.name as string;
            const { scalar, props } = extractScalarProps(f);
            return {
              name: `${ef.name}_${subName}`,
              scalar,
              sqlType: scalarToSql(scalar, props, dialect),
            };
          }),
        };
      }
    }
    return {
      name: ef.name,
      scalar: null,
      refType: ef.refValueTypeId,
      props: ef.props as Record<string, unknown>,
    };
  }

  // Scalar field
  return {
    name: ef.name,
    scalar: ef.scalar,
    props: ef.props as Record<string, unknown>,
    sqlType: scalarToSql(ef.scalar, ef.props, dialect),
  };
}

function extractScalarProps(f: Record<string, unknown>): {
  scalar: string;
  props: Record<string, unknown>;
} {
  const rawType = f.type;
  if (typeof rawType === 'string') {
    const scalar = rawType.includes('.') ? rawType.slice(rawType.lastIndexOf('.') + 1) : rawType;
    return { scalar, props: {} };
  }
  if (typeof rawType === 'object' && rawType !== null) {
    const desc = rawType as { ref?: string; args?: Record<string, unknown> };
    const ref = desc.ref ?? '';
    const scalar = ref.includes('.') ? ref.slice(ref.lastIndexOf('.') + 1) : ref;
    return { scalar, props: desc.args ?? {} };
  }
  return { scalar: 'string', props: {} };
}

function formatOwner(owner: ExtensionFieldEntry['owner']): string {
  switch (owner.kind) {
    case 'platform':
      return 'platform';
    case 'ext':
      return `ext:${owner.provider}`;
    case 'tenant':
      return `tenant:${owner.id}`;
  }
}
