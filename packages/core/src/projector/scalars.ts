/**
 * Scalar → SQL type mapping — single source of truth for all dialects.
 *
 * Both the dialect projectors (pg/mysql/sqlite) and the CLI's
 * project model JSON serializer consume this. Extracting it here
 * eliminates the 4-way duplication that previously drifted.
 */
import type { Dialect } from './sql.js';

/** Map a loom scalar + props to a dialect-specific SQL type string. */
export function scalarToSql(
  scalar: string,
  props: Readonly<Record<string, unknown>>,
  dialect: Dialect,
): string {
  switch (dialect) {
    case 'pg':
      return scalarToPg(scalar, props);
    case 'mysql':
      return scalarToMysql(scalar, props);
    case 'sqlite':
      return scalarToSqlite(scalar);
  }
}

function scalarToPg(scalar: string, props: Readonly<Record<string, unknown>>): string {
  switch (scalar) {
    case 'boolean':
      return 'BOOLEAN';
    case 'uint8':
    case 'int16':
      return 'SMALLINT';
    case 'integer':
      return 'INTEGER';
    case 'bigint':
      return 'BIGINT';
    case 'decimal':
      return `NUMERIC(${props.precision ?? 18},${props.scale ?? 4})`;
    case 'double':
      return 'DOUBLE PRECISION';
    case 'string':
      return `VARCHAR(${props.max_length ?? 255})`;
    case 'largestring':
      return 'TEXT';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'datetime':
    case 'timestamp':
      return 'TIMESTAMPTZ';
    case 'uuid':
      return 'UUID';
    case 'binary':
    case 'largebinary':
      return 'BYTEA';
    case 'vector':
      return `vector(${props.length ?? 1})`;
    case 'map':
      return 'JSONB';
    default:
      return 'TEXT';
  }
}

function scalarToMysql(scalar: string, props: Readonly<Record<string, unknown>>): string {
  switch (scalar) {
    case 'boolean':
      return 'BOOLEAN';
    case 'uint8':
      return 'TINYINT';
    case 'int16':
      return 'SMALLINT';
    case 'integer':
      return 'INT';
    case 'bigint':
      return 'BIGINT';
    case 'decimal':
      return `DECIMAL(${props.precision ?? 18},${props.scale ?? 4})`;
    case 'double':
      return 'DOUBLE';
    case 'string':
      return `VARCHAR(${props.max_length ?? 255})`;
    case 'largestring':
      return 'LONGTEXT';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME(6)';
    case 'datetime':
      return 'DATETIME(6)';
    case 'timestamp':
      return 'TIMESTAMP(6)';
    case 'uuid':
      return 'CHAR(36)';
    case 'binary':
      return `VARBINARY(${props.max_length ?? 255})`;
    case 'largebinary':
      return 'LONGBLOB';
    case 'vector':
      return 'LONGBLOB';
    case 'map':
      return 'JSON';
    default:
      return 'TEXT';
  }
}

function scalarToSqlite(scalar: string): string {
  switch (scalar) {
    case 'boolean':
    case 'uint8':
    case 'int16':
    case 'integer':
    case 'bigint':
      return 'INTEGER';
    case 'decimal':
      return 'NUMERIC';
    case 'double':
      return 'REAL';
    case 'string':
    case 'largestring':
    case 'uuid':
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
      return 'TEXT';
    case 'binary':
    case 'largebinary':
      return 'BLOB';
    case 'vector':
      return 'vec';
    case 'map':
      return 'TEXT';
    default:
      return 'TEXT';
  }
}

/** Shared onDelete mapping for all dialects. */
export function formatOnDelete(o: 'cascade' | 'restrict' | 'set_null' | 'no_action'): string {
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
