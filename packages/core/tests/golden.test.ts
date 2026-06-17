import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { load } from '../src/loader/index.js';
import { projectSqlFromIr } from '../src/projector/sql.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('golden: base_schema.pg.sql', () => {
  it('matches the committed golden file', async () => {
    const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
    const sql = projectSqlFromIr(ir, 'pg');
    const golden = readFileSync(resolve(here, 'golden/base_schema.pg.sql'), 'utf-8');
    expect(sql).toBe(golden);
  });
});
