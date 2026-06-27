import { escapeSqlSingleQuote, formatEnumComment } from '../enumMeta.js';
import { formatOnDelete, scalarToSql } from '../scalars.js';
/**
 * MySQL dialect.
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
    if ((t.strategy === 'sidecar_eav' || t.strategy === 'sidecar_jsonb') && t.extTableName) {
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
    const comment = columnEnumComment(c, ctx);
    body.push(
      `  ${c.name} ${mysqlType(c, ctx)}${c.required ? ' NOT NULL' : ''}${c.unique ? ' UNIQUE' : ''}${comment !== undefined ? ` COMMENT '${escapeSqlSingleQuote(comment)}'` : ''}`,
    );
    // Integer-backed enum: emit CHECK constraint inline.
    if (c.enumRef) {
      const entry = ctx.model.enums.get(c.enumRef);
      if (entry && entry.carrier !== 'string') {
        const vals = entry.variants.map((v) => v.value).join(', ');
        body.push(`  CONSTRAINT ${c.name}_check CHECK (${c.name} IN (${vals}))`);
      }
    }
  }
  if (t.primaryKey.length > 0) {
    body.push(`  PRIMARY KEY (${t.primaryKey.join(', ')})`);
  }
  for (const fk of t.foreignKeys) {
    body.push(
      `  CONSTRAINT ${fk.name} FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refTable} (${fk.refColumns.join(', ')})${fk.onDelete ? ` ON DELETE ${formatOnDelete(fk.onDelete)}` : ''}`,
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
  const pkCols = t.sidecarPkColumns ?? ['base_id'];
  const body: string[] = [];
  for (let i = 0; i < pkCols.length; i++) {
    body.push(`  base_id_${i} BIGINT NOT NULL`);
  }
  body.push("  source CHAR(16) NOT NULL");
  body.push("  values JSON NOT NULL DEFAULT (JSON_OBJECT())");
  body.push('  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)');
  lines.push(body.join(',\n'));
  lines.push(');');
  return lines.join('\n');
}

function viewBlock(v: PivotView): string {
  const selectCols: string[] = [...v.baseColumns];
  for (const c of v.columns) {
    selectCols.push(`${c.groupAlias}.values->>'$.${c.fieldName}' AS ${c.fieldName}`);
  }
  const joins = v.groupJoins.map((g) => {
    const pkCount = v.basePkColumns.length;
    const joinConds: string[] = [];
    for (let i = 0; i < pkCount; i++) {
      joinConds.push(`${g.alias}.base_id_${i} = u.${v.basePkColumns[i]}`);
    }
    joinConds.push(`${g.alias}.source = '${g.sourceHash}'`);
    return `LEFT JOIN ${v.extTable} ${g.alias} ON ${joinConds.join(' AND ')}`;
  });
  return `CREATE VIEW ${v.viewName} AS\nSELECT\n${selectCols.map((c) => `  ${c}`).join(',\n')}\nFROM ${v.baseTable} u${joins.length > 0 ? '\n' : ''}${joins.join('\n')};`;
}

function mysqlType(c: PhysicalColumn, ctx: MysqlEmitContext): string {
  if (c.enumRef) {
    const entry = ctx.model.enums.get(c.enumRef);
    if (entry) {
      // Integer-backed enum: use the carrier scalar's SQL type.
      if (entry.carrier !== 'string') {
        return scalarToSql(entry.carrier, c.props as Record<string, unknown>, 'mysql');
      }
      // String-backed enum: MySQL native ENUM(...).
      return `ENUM(${entry.variants.map((v) => `'${v.value}'`).join(', ')})`;
    }
  }
  return scalarToSql(c.scalar, c.props as Record<string, unknown>, 'mysql');
}

/**
 * Structured `loom:enum` comment for a column backed by an enum, if that enum
 * carries variant metadata. Returns undefined for non-enum columns or enums
 * with no metadata (keeps the DDL clean for bare value lists).
 */
function columnEnumComment(c: PhysicalColumn, ctx: MysqlEmitContext): string | undefined {
  if (!c.enumRef) return undefined;
  const entry = ctx.model.enums.get(c.enumRef);
  if (!entry) return undefined;
  return formatEnumComment(entry.variants);
}
