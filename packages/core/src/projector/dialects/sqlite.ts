import { formatEnumComment } from '../enumMeta.js';
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
    if ((t.strategy === 'sidecar_eav' || t.strategy === 'sidecar_jsonb') && t.extTableName) {
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
    // Structured `loom:enum` line comment above an enum-backed column, so
    // reverse-engineering tools can recover variant labels. SQLite has no
    // native COMMENT syntax; a `--` line is the portable convention. Only
    // emitted when the enum carries variant metadata.
    if (c.enumRef) {
      const entry = ctx.model.enums.get(c.enumRef);
      if (entry) {
        const comment = formatEnumComment(entry.variants);
        if (comment !== undefined) {
          body.push(`  -- ${comment}`);
        }
      }
    }
    body.push(
      `  ${c.name} ${sqliteType(c, ctx)}${c.required ? ' NOT NULL' : ''}${c.unique ? ' UNIQUE' : ''}`,
    );
    if (c.enumRef) {
      const entry = ctx.model.enums.get(c.enumRef);
      if (entry) {
        // Integer-backed enum: values are unquoted numbers.
        const quote = entry.carrier !== 'string' ? '' : "'";
        const vals = entry.variants.map((v) => `${quote}${v.value}${quote}`).join(', ');
        body.push(`  CHECK (${c.name} IN (${vals}))`);
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
  const pkCols = t.sidecarPkColumns ?? ['base_id'];
  const body: string[] = [];
  for (let i = 0; i < pkCols.length; i++) {
    body.push(`  base_id_${i} INTEGER NOT NULL`);
  }
  body.push("  source TEXT NOT NULL");
  body.push("  values TEXT NOT NULL DEFAULT '{}'");
  body.push("  created_at TEXT NOT NULL DEFAULT (datetime('now'))");
  lines.push(body.join(',\n'));
  lines.push(');');
  return lines.join('\n');
}

function viewBlock(v: PivotView): string {
  const selectCols: string[] = [...v.baseColumns];
  for (const c of v.columns) {
    selectCols.push(`json_extract(${c.groupAlias}.values, '$.${c.fieldName}') AS ${c.fieldName}`);
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

function sqliteType(c: PhysicalColumn, ctx: SqliteEmitContext): string {
  // Integer-backed enum: use the carrier scalar's SQL type.
  if (c.enumRef) {
    const entry = ctx.model.enums.get(c.enumRef);
    if (entry && entry.carrier !== 'string') {
      return scalarToSql(entry.carrier, c.props as Record<string, unknown>, 'sqlite');
    }
  }
  return scalarToSql(c.scalar, c.props as Record<string, unknown>, 'sqlite');
}
