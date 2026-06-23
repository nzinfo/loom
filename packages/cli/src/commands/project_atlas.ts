/**
 * `loom project atlas-yaml --dialect <d> <path>`
 *
 * Outputs atlas-yaml/v2 format for atlas integration. Only covers physical
 * base tables (columns, primary_key, indexes, foreign_keys) — no ext tables,
 * views, or entities (those are loom concepts atlas doesn't need).
 *
 * The output is consumable by atlas's schemayaml.Unmarshal.
 */
import process from 'node:process';
import { expandTables, load } from '@loom/core';
import type { Dialect, PhysicalColumn, PhysicalModel, PhysicalTable } from '@loom/core';
import { scalarToSql } from '@loom/core';
import { stringify } from 'yaml';
import { NodeFileSystem } from '../shared/fs.js';
import { writeError } from '../shared/output.js';

const DIALECTS: readonly Dialect[] = ['pg', 'mysql', 'sqlite'];

/** Map loom dialect name to atlas dialect name. */
function atlasDialectName(d: Dialect): string {
  switch (d) {
    case 'pg':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
  }
}

export interface ProjectAtlasOptions {
  readonly path: string;
  readonly dialect: string | undefined;
  readonly physicalSchemas: readonly string[];
}

export async function projectAtlasCommand(opts: ProjectAtlasOptions): Promise<number> {
  const dialect = (opts.dialect ?? 'pg') as Dialect;
  if (!DIALECTS.includes(dialect)) {
    writeError(`--dialect must be one of ${DIALECTS.join(', ')}`);
    return 64;
  }

  const physicalSchemaOverrides = new Map<string, string>();
  for (const spec of opts.physicalSchemas) {
    const eq = spec.indexOf('=');
    if (eq <= 0) {
      writeError(`--physical-schema expects "<module.fqn>=<name>", got "${spec}"`);
      return 64;
    }
    physicalSchemaOverrides.set(spec.slice(0, eq), spec.slice(eq + 1));
  }

  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });
  if (result.diagnostics.hasErrors) {
    process.stderr.write(result.diagnostics.format());
    process.stderr.write('\n');
    return 1;
  }

  const projectOpts =
    physicalSchemaOverrides.size > 0 ? physicalSchemaOverrides : undefined;
  const model = expandTables(result.ir, projectOpts);
  const yaml = buildAtlasYaml(model, dialect);
  process.stdout.write(yaml);
  return 0;
}

// ── YAML structure types ──────────────────────────────────────

interface AtlasColumn {
  name: string;
  type: { kind: string; t: string; [k: string]: unknown };
  raw: string;
  null: boolean;
}

interface AtlasPart {
  seq: number;
  column_ref: string;
}

interface AtlasPrimaryKey {
  name: string;
  parts: AtlasPart[];
}

interface AtlasIndex {
  name: string;
  parts: AtlasPart[];
  unique?: boolean;
}

interface AtlasForeignKey {
  name: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  on_delete?: string;
}

interface AtlasTable {
  name: string;
  columns: AtlasColumn[];
  primary_key?: AtlasPrimaryKey;
  indexes?: AtlasIndex[];
  foreign_keys?: AtlasForeignKey[];
}

interface AtlasSchema {
  name: string;
  tables: AtlasTable[];
}

interface AtlasRealm {
  schemas: AtlasSchema[];
}

// ── builder ───────────────────────────────────────────────────

function buildAtlasYaml(model: PhysicalModel, dialect: Dialect): string {
  // Group tables by schema.
  const schemaMap = new Map<string, AtlasTable[]>();
  for (const t of model.tables) {
    const schemaName = t.schema ?? 'main';
    let bucket = schemaMap.get(schemaName);
    if (bucket === undefined) {
      bucket = [];
      schemaMap.set(schemaName, bucket);
    }
    bucket.push(serializeTable(t, dialect));
  }

  const schemas: AtlasSchema[] = [];
  for (const [name, tables] of schemaMap) {
    schemas.push({ name, tables });
  }

  const realm: AtlasRealm = { schemas };
  const doc = { version: 'atlas-yaml/v2', realm };

  return stringify(doc, { indent: 4, lineWidth: 0 });
}

function serializeTable(t: PhysicalTable, dialect: Dialect): AtlasTable {
  const schema = t.schema ?? 'main';
  const colPrefix = `column:${schema}.${t.name}`;

  const columns: AtlasColumn[] = t.columns.map((c) => serializeColumn(c, dialect));

  const table: AtlasTable = { name: t.name, columns };

  // Primary key
  if (t.primaryKey.length > 0) {
    table.primary_key = {
      name: 'PRIMARY',
      parts: t.primaryKey.map((col, i) => ({
        seq: i,
        column_ref: `${colPrefix}.${col}`,
      })),
    };
  }

  // Indexes
  if (t.indexes.length > 0) {
    table.indexes = t.indexes.map((idx) => ({
      name: idx.name,
      parts: idx.columns.map((col, i) => ({
        seq: i,
        column_ref: `${colPrefix}.${col}`,
      })),
      ...(idx.unique ? { unique: true } : {}),
    }));
  }

  // Foreign keys
  if (t.foreignKeys.length > 0) {
    table.foreign_keys = t.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: [...fk.columns],
      ref_table: `table:${schema}.${fk.refTable}`,
      ref_columns: [...fk.refColumns],
      ...(fk.onDelete ? { on_delete: formatOnDelete(fk.onDelete) } : {}),
    }));
  }

  return table;
}

function serializeColumn(c: PhysicalColumn, dialect: Dialect): AtlasColumn {
  const rawSql = scalarToSql(c.scalar, c.props as Record<string, unknown>, dialect);
  const typeInfo = scalarToAtlasType(c.scalar, c.props as Record<string, unknown>, dialect);

  return {
    name: c.name,
    type: typeInfo,
    raw: rawSql,
    null: !c.required,
  };
}

/** Map a loom scalar to atlas type.kind + t + extra fields. */
function scalarToAtlasType(
  scalar: string,
  props: Record<string, unknown>,
  dialect: Dialect,
): { kind: string; t: string; [k: string]: unknown } {
  // For most types, `t` = the raw SQL type from scalarToSql, and kind is
  // determined by the scalar category.
  const t = rawSqlName(scalar, props, dialect);

  switch (scalar) {
    case 'bigint':
    case 'integer':
    case 'int16':
    case 'uint8':
      return { kind: 'schema:integer', t };
    case 'decimal':
      return { kind: 'schema:decimal', t };
    case 'double':
      return { kind: 'schema:float', t };
    case 'string':
      return {
        kind: 'schema:string',
        t: dialect === 'pg' ? 'character varying' : 'varchar',
        ...(props.max_length !== undefined ? { size: props.max_length } : {}),
      };
    case 'largestring':
      return { kind: 'schema:string', t: 'text' };
    case 'boolean':
      return { kind: 'schema:bool', t };
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
      return { kind: 'schema:time', t };
    case 'uuid':
      return { kind: 'schema:string', t: 'uuid' };
    case 'binary':
    case 'largebinary':
      return { kind: 'schema:binary', t };
    case 'vector':
      // atlas doesn't have a built-in vector type; emit as user-defined
      return {
        kind: `${atlasDialectName(dialect)}:user_defined_type`,
        t: `vector(${props.length ?? 1})`,
      };
    case 'map':
      return { kind: 'schema:json', t };
    default:
      return { kind: 'schema:string', t: 'text' };
  }
}

/** Get the dialect-specific SQL type name (without kind wrapper). */
function rawSqlName(
  scalar: string,
  props: Record<string, unknown>,
  dialect: Dialect,
): string {
  return scalarToSql(scalar, props, dialect);
}

function formatOnDelete(o: string): string {
  switch (o) {
    case 'cascade':
      return 'CASCADE';
    case 'restrict':
      return 'RESTRICT';
    case 'set_null':
      return 'SET NULL';
    case 'no_action':
      return 'NO ACTION';
    default:
      return o.toUpperCase();
  }
}
