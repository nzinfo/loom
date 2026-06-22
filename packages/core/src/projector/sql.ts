/**
 * SQL projector facade. See spec §8.3, §8.4, §8.5.
 *
 * Builds the dialect-neutral physical model from the IR, computes pivot
 * views for sidecar_eav tables, and dispatches to the requested dialect.
 */
import type { IR } from '../ir/version.js';
import { projectMysql } from './dialects/mysql.js';
import { projectPg } from './dialects/pg.js';
import { projectSqlite } from './dialects/sqlite.js';
import { expandTables } from './expand.js';
import { buildPivotViews } from './views.js';

export type Dialect = 'pg' | 'mysql' | 'sqlite';

export interface ProjectSqlOptions {
  /**
   * Per-module physical-schema overrides (module fqn → physical schema name).
   * Replaces the derived `<system>_<module>` default. Typically sourced from
   * a CLI flag. module_manifest is gone; physical_schema is projection-time.
   */
  readonly physicalSchemaOverrides?: ReadonlyMap<string, string>;
}

export function projectSqlFromIr(ir: IR, dialect: Dialect, opts?: ProjectSqlOptions): string {
  const model = expandTables(ir, opts?.physicalSchemaOverrides);
  const pivotViews = buildPivotViews(model, ir);
  switch (dialect) {
    case 'pg':
      return projectPg({ model, pivotViews });
    case 'mysql':
      return projectMysql({ model, pivotViews });
    case 'sqlite':
      return projectSqlite({ model, pivotViews });
  }
}
