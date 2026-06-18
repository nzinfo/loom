/**
 * MySQL dialect. See spec §8.4, §6.2, §11, §7.4.
 *
 * enum → inline ENUM('a','b') in the column definition. No CREATE TYPE.
 * pivot views use the same correlated-subquery shape as PG.
 */
import type { PhysicalColumn, PhysicalModel, PhysicalTable } from '../types.js';
import type { PivotView } from '../views.js';

export interface MysqlEmitContext {
  readonly model: PhysicalModel;
  readonly pivotViews: readonly PivotView[];
}

export function projectMysql(ctx: MysqlEmitContext): string {
  const blocks: string[] = [];
  for (const t of ctx.model.tables) {
    blocks.push(tableBlock(t, ctx));
    if (t.strategy === 'sidecar_eav' && t.extTableName) {
      blocks.push(extTableBlock(t));
    }
  }
  for (const v of ctx.pivotViews) {
    blocks.push(viewBlock(v));
  }
  return blocks.join('\n\n');
}

function tableBlock(t: PhysicalTable, ctx: MysqlEmitContext): string {
  const lines: string[] = [];
  lines.push(`CREATE TABLE ${t.qualifiedName} (`);
  const body: string[] = [];
  for (const c of t.columns) {
    body.push(
      `  ${c.name} ${mysqlType(c, ctx)}${c.required ? ' NOT NULL' : ''}${c.unique ? ' UNIQUE' : ''}`,
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
  lines.push('  tenant_id BIGINT,');
  lines.push('  field_name VARCHAR(100) NOT NULL,');
  lines.push('  data_type VARCHAR(20) NOT NULL,');
  lines.push('  int_value BIGINT,');
  lines.push('  decimal_value DECIMAL(18,4),');
  lines.push('  string_value TEXT,');
  lines.push('  datetime_value DATETIME(6),');
  lines.push('  boolean_value BOOLEAN,');
  lines.push('  json_value JSON,');
  lines.push('  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)');
  lines.push(');');
  return lines.join('\n');
}

function viewBlock(v: PivotView): string {
  const selectCols: string[] = [...v.baseColumns];
  for (const c of v.columns) {
    selectCols.push(
      `(SELECT ${c.eavColumn} FROM ${v.extTable} e WHERE e.base_id = u.id AND e.field_name = '${c.fieldName}' LIMIT 1) AS ${c.fieldName}`,
    );
  }
  return `CREATE VIEW ${v.viewName} AS\nSELECT\n${selectCols.map((c) => `  ${c}`).join(',\n')}\nFROM ${v.baseTable} u;`;
}

function mysqlType(c: PhysicalColumn, ctx: MysqlEmitContext): string {
  if (c.enumRef) {
    const values = ctx.model.enums.get(c.enumRef);
    if (values) {
      return `ENUM(${values.map((v) => `'${v}'`).join(', ')})`;
    }
  }
  switch (c.scalar) {
    case 'boolean':
      return 'BOOLEAN';
    case 'integer':
      return 'INT';
    case 'bigint':
      return 'BIGINT';
    case 'decimal': {
      const p = c.props.precision;
      const s = c.props.scale;
      return `DECIMAL(${p ?? 18},${s ?? 4})`;
    }
    case 'string':
      return `VARCHAR(${c.props.max_length ?? 255})`;
    case 'text':
      return 'TEXT';
    case 'datetime':
      return 'DATETIME(6)';
    case 'date':
      return 'DATE';
    case 'uuid':
      return 'CHAR(36)';
    case 'bytes':
      return 'BLOB';
    case 'json':
      return 'JSON';
    default:
      return 'TEXT';
  }
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
