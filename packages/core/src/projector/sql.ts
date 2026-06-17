/**
 * SQL projector facade. See spec §8.3, §8.4, §8.5.
 *
 * Builds the dialect-neutral physical model from the IR, computes pivot
 * views for sidecar_eav tables, and dispatches to the requested dialect.
 */
import type { IR } from '../ir/version.js';
import { expandTables } from './expand.js';
import { buildPivotViews } from './views.js';
import { projectPg } from './dialects/pg.js';
import { projectMysql } from './dialects/mysql.js';
import { projectSqlite } from './dialects/sqlite.js';

export type Dialect = 'pg' | 'mysql' | 'sqlite';

export function projectSqlFromIr(ir: IR, dialect: Dialect): string {
  const model = expandTables(ir);
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
