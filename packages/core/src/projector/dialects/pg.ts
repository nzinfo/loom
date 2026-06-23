/**
 * PostgreSQL dialect. See spec §8.4, §6.2 (qualified names), §11 (enum types),
 * §7.4 (pivot views).
 */
import type { PhysicalColumn, PhysicalModel, PhysicalTable } from '../types.js';
import type { PivotView } from '../views.js';

export interface PgEmitContext {
  readonly model: PhysicalModel;
  readonly pivotViews: readonly PivotView[];
}

export function projectPg(ctx: PgEmitContext): string {
  const blocks: string[] = [];

  // 0. Extensions — only emitted when a column actually uses the type
  //    (on-demand activation, not unconditional).
  if (usesVector(ctx.model)) {
    blocks.push('CREATE EXTENSION IF NOT EXISTS vector;');
  }

  // 1. Enum types (spec §11) — PG requires them declared before use.
  for (const [id, values] of ctx.model.enums) {
    const pgName = pgEnumName(id);
    blocks.push(`CREATE TYPE ${pgName} AS ENUM (${values.map((v) => `'${v}'`).join(', ')});`);
  }

  // 2. Base tables (and ext tables for sidecar_eav).
  for (const t of ctx.model.tables) {
    blocks.push(tableBlock(t, ctx));
    if (t.strategy === 'sidecar_eav' && t.extTableName) {
      blocks.push(extTableBlock(t));
    }
  }

  // 3. Pivot views for sidecar_eav tables.
  for (const v of ctx.pivotViews) {
    blocks.push(viewBlock(v));
  }

  return blocks.join('\n\n');
}

/** True if any column in the model uses the vector scalar. */
function usesVector(model: PhysicalModel): boolean {
  return model.tables.some((t) => t.columns.some((c) => c.scalar === 'vector'));
}

function tableBlock(t: PhysicalTable, ctx: PgEmitContext): string {
  const lines: string[] = [];
  lines.push(`CREATE TABLE ${t.qualifiedName} (`);
  const body: string[] = [];
  for (const c of t.columns) {
    body.push(
      `  ${c.name} ${pgType(c, ctx)}${c.required ? ' NOT NULL' : ''}${c.unique ? ' UNIQUE' : ''}`,
    );
  }
  if (t.primaryKey.length > 0) {
    body.push(`  PRIMARY KEY (${t.primaryKey.join(', ')})`);
  }
  for (const fk of t.foreignKeys) {
    body.push(
      `  CONSTRAINT ${fk.name} FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refTable} (${fk.refColumns.join(', ')})${fk.onDelete ? ` ON DELETE ${onDelete(fk.onDelete)}` : ''}`,
    );
  }
  lines.push(body.join(',\n'));
  lines.push(');');
  for (const idx of t.indexes) {
    lines.push(
      `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${t.qualifiedName} (${idx.columns.join(', ')});`,
    );
  }
  return lines.join('\n');
}

function extTableBlock(t: PhysicalTable): string {
  const schema = t.schema !== undefined ? `${t.schema}.` : '';
  const extQual = `${schema}${t.extTableName}`;
  const lines: string[] = [];
  lines.push(`CREATE TABLE ${extQual} (`);
  lines.push('  base_id BIGINT NOT NULL,');
  lines.push('  scope BIGINT NOT NULL,');
  lines.push('  group_name VARCHAR(50) NOT NULL,');
  lines.push("  values JSONB NOT NULL DEFAULT '{}'::jsonb,");
  lines.push('  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  lines.push(');');
  return lines.join('\n');
}

function viewBlock(v: PivotView): string {
  const selectCols: string[] = [...v.baseColumns];
  for (const c of v.columns) {
    selectCols.push(`${c.groupAlias}.values->>'${c.fieldName}' AS ${c.fieldName}`);
  }
  const joins = v.groupJoins.map(
    (g) =>
      `LEFT JOIN ${v.extTable} ${g.alias} ON ${g.alias}.base_id = u.id AND ${g.alias}.group_name = '${g.group}'`,
  );
  return `CREATE VIEW ${v.viewName} AS\nSELECT\n${selectCols.map((c) => `  ${c}`).join(',\n')}\nFROM ${v.baseTable} u${joins.length > 0 ? '\n' : ''}${joins.join('\n')};`;
}

function pgType(c: PhysicalColumn, ctx: PgEmitContext): string {
  if (c.enumRef) {
    return pgEnumName(c.enumRef);
  }
  switch (c.scalar) {
    case 'boolean':
      return 'BOOLEAN';
    case 'uint8':
      return 'SMALLINT';
    case 'int16':
      return 'SMALLINT';
    case 'integer':
      return 'INTEGER';
    case 'bigint':
      return 'BIGINT';
    case 'decimal': {
      const p = c.props.precision;
      const s = c.props.scale;
      return `NUMERIC(${p ?? 18},${s ?? 4})`;
    }
    case 'double':
      return 'DOUBLE PRECISION';
    case 'string':
      return `VARCHAR(${c.props.max_length ?? 255})`;
    case 'largestring':
      return 'TEXT';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'datetime':
      return 'TIMESTAMPTZ';
    case 'timestamp':
      return 'TIMESTAMPTZ';
    case 'uuid':
      return 'UUID';
    case 'binary':
      return 'BYTEA';
    case 'largebinary':
      return 'BYTEA';
    case 'vector':
      return `vector(${c.props.length ?? 1})`;
    case 'map':
      return 'JSONB';
    default:
      return 'TEXT';
  }
}

function pgEnumName(valueTypeId: string): string {
  // type:base.core.Status → base_core_status
  const colon = valueTypeId.indexOf(':');
  const body = valueTypeId.slice(colon + 1);
  const [sys, mod, name] = body.split('.');
  return `${sys}_${mod}_${name?.toLowerCase()}`;
}

function onDelete(o: 'cascade' | 'restrict' | 'set_null' | 'no_action'): string {
  switch (o) {
    case 'cascade':
      return 'CASCADE';
    case 'restrict':
      return 'RESTRICT';
    case 'set_null':
      return 'SET NULL';
    case 'no_action':
      return 'NO ACTION';
  }
}
