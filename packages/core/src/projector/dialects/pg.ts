import { escapeSqlSingleQuote, formatEnumComment } from '../enumMeta.js';
import { formatOnDelete, scalarToSql } from '../scalars.js';
/**
 * PostgreSQL dialect.
 */
import type { PhysicalColumn, PhysicalModel, PhysicalTable } from '../types.js';
import type { PivotView } from '../views.js';

export interface PgEmitContext {
  readonly model: PhysicalModel;
  readonly pivotViews: readonly PivotView[];
}

export function projectPg(ctx: PgEmitContext): string {
  const blocks: string[] = [];

  if (usesVector(ctx.model)) {
    blocks.push('CREATE EXTENSION IF NOT EXISTS vector;');
  }

  for (const [id, entry] of ctx.model.enums) {
    // Only emit CREATE TYPE for string-backed enums — integer carriers
    // use column-level CHECK constraints instead.
    if (entry.carrier !== 'string') continue;
    const pgName = pgEnumName(id);
    blocks.push(
      `CREATE TYPE ${pgName} AS ENUM (${entry.variants.map((v) => `'${v.value}'`).join(', ')});`,
    );
    // Structured comment so reverse-engineering tools can recover variant
    // labels (display_name/description) from the DB. Only emitted when at
    // least one variant carries metadata.
    const comment = formatEnumComment(entry.variants);
    if (comment !== undefined) {
      blocks.push(`COMMENT ON TYPE ${pgName} IS '${escapeSqlSingleQuote(comment)}';`);
    }
  }

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
  const pkCols = t.sidecarPkColumns ?? ['base_id'];
  const pkScalars = t.sidecarPkScalars ?? pkCols.map(() => 'bigint');
  const pkProps = t.sidecarPkProps ?? pkCols.map(() => ({}));
  const body: string[] = [];
  for (let i = 0; i < pkCols.length; i++) {
    const sqlType = scalarToSql(pkScalars[i] ?? 'bigint', pkProps[i] ?? {}, 'pg');
    body.push(`  base_id_${i} ${sqlType} NOT NULL`);
  }
  body.push('  source CHAR(16) NOT NULL');
  body.push("  values JSONB NOT NULL DEFAULT '{}'::jsonb");
  body.push('  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');

  const lines: string[] = [];
  lines.push(`CREATE TABLE ${extQual} (`);
  lines.push(body.join(',\n'));
  lines.push(');');
  // Index on base_id columns + source for efficient lookup.
  const extraPkCols =
    pkCols.length > 1
      ? `, ${pkCols
          .slice(1)
          .map((_, i) => `base_id_${i + 1}`)
          .join(', ')}`
      : '';
  lines.push(
    `CREATE INDEX idx_${t.extTableName}_source ON ${extQual} (base_id_0${extraPkCols}, source);`,
  );
  return lines.join('\n');
}

function viewBlock(v: PivotView): string {
  const selectCols: string[] = [...v.baseColumns];
  for (const c of v.columns) {
    selectCols.push(`${c.groupAlias}.values->>'${c.fieldName}' AS ${c.fieldName}`);
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

function pgType(c: PhysicalColumn, ctx: PgEmitContext): string {
  if (c.enumRef) {
    const entry = ctx.model.enums.get(c.enumRef);
    // Integer-backed enum: use the carrier scalar's SQL type.
    if (entry && entry.carrier !== 'string') {
      return scalarToSql(entry.carrier, c.props as Record<string, unknown>, 'pg');
    }
    // String-backed enum: use PG native ENUM type name.
    return pgEnumName(c.enumRef);
  }
  return scalarToSql(c.scalar, c.props as Record<string, unknown>, 'pg');
}

function pgEnumName(valueTypeId: string): string {
  const colon = valueTypeId.indexOf(':');
  const body = valueTypeId.slice(colon + 1);
  const [sys, mod, name] = body.split('.');
  return `${sys}_${mod}_${name?.toLowerCase()}`;
}
