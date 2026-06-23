import { formatOnDelete, scalarToSql } from '../scalars.js';
/**
 * SQLite dialect.
 */
import type { PhysicalColumn, PhysicalModel, PhysicalTable } from '../types.js';
import type { PivotView } from '../views.js';

export interface SqliteEmitContext {
  readonly model: PhysicalModel;
  readonly pivotViews: readonly PivotView[];
}

export function projectSqlite(ctx: SqliteEmitContext): string {
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

function tableBlock(t: PhysicalTable, ctx: SqliteEmitContext): string {
  const lines: string[] = [];
  lines.push(`CREATE TABLE ${t.qualifiedName} (`);
  const body: string[] = [];
  for (const c of t.columns) {
    body.push(
      `  ${c.name} ${sqliteType(c)}${c.required ? ' NOT NULL' : ''}${c.unique ? ' UNIQUE' : ''}`,
    );
    if (c.enumRef) {
      const values = ctx.model.enums.get(c.enumRef);
      if (values) {
        body.push(`  CHECK (${c.name} IN (${values.map((v) => `'${v}'`).join(', ')}))`);
      }
    }
  }
  if (t.primaryKey.length > 0) {
    body.push(`  PRIMARY KEY (${t.primaryKey.join(', ')})`);
  }
  for (const fk of t.foreignKeys) {
    body.push(
      `  FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refTable} (${fk.refColumns.join(', ')})${fk.onDelete ? ` ON DELETE ${formatOnDelete(fk.onDelete)}` : ''}`,
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
  lines.push('  base_id INTEGER NOT NULL,');
  lines.push('  scope INTEGER NOT NULL,');
  lines.push('  group_name TEXT NOT NULL,');
  lines.push("  values TEXT NOT NULL DEFAULT '{}',");
  lines.push("  created_at TEXT NOT NULL DEFAULT (datetime('now'))");
  lines.push(');');
  return lines.join('\n');
}

function viewBlock(v: PivotView): string {
  const selectCols: string[] = [...v.baseColumns];
  for (const c of v.columns) {
    selectCols.push(`json_extract(${c.groupAlias}.values, '$.${c.fieldName}') AS ${c.fieldName}`);
  }
  const joins = v.groupJoins.map(
    (g) =>
      `LEFT JOIN ${v.extTable} ${g.alias} ON ${g.alias}.base_id = u.id AND ${g.alias}.group_name = '${g.group}'`,
  );
  return `CREATE VIEW ${v.viewName} AS\nSELECT\n${selectCols.map((c) => `  ${c}`).join(',\n')}\nFROM ${v.baseTable} u${joins.length > 0 ? '\n' : ''}${joins.join('\n')};`;
}

function sqliteType(c: PhysicalColumn): string {
  return scalarToSql(c.scalar, c.props as Record<string, unknown>, 'sqlite');
}
