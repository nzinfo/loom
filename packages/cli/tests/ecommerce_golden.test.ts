/**
 * Golden regression test for examples/ecommerce.
 *
 * ecommerce is the comprehensive fixture covering: base tables, sidecar_jsonb
 * ext, new_table ext, master-detail (Order→OrderItem), composite PK, shared
 * sidecar table (Products/Categories), tenant-owned ext, and PK-type-diverse
 * sidecars (bigint vs uuid). This test locks the projected SQL so any drift
 * in the projector (entity→view field attribution, base_id type derivation,
 * JOIN structure) surfaces immediately.
 *
 * Why unit-test style (not e2e subprocess): direct load() + projectSqlFromIr
 * is ~100x faster than spawning the CLI and gives precise diff output on
 * mismatch. Subprocess e2e tests in tests/e2e/ cover the CLI plumbing;
 * golden projection correctness lives here.
 *
 * Regenerating goldens: the test reads and writes the same path the test
 * compares against, so a single source of truth generates + checks. Run with
 * `UPDATE_GOLDEN=1 pnpm test` to refresh both files, then review the diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, projectSqlFromIr } from '@loom/core';
import { describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../src/shared/fs.js';

const here = dirname(fileURLToPath(import.meta.url));
const ecommerceDir = resolve(here, '../../../examples/ecommerce');
const goldenDir = resolve(here, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Load ecommerce once; both pg/sqlite tests share the same IR. */
async function loadEcommerce() {
  const { ir } = await load({ fs: new NodeFileSystem(), basePath: ecommerceDir });
  return ir;
}

describe('golden: examples/ecommerce', () => {
  it('pg projection matches golden', async () => {
    const sql = projectSqlFromIr(await loadEcommerce(), 'pg');
    const path = resolve(goldenDir, 'ecommerce.pg.sql');
    if (UPDATE) {
      writeFileSync(path, sql);
      return;
    }
    expect(sql).toBe(readFileSync(path, 'utf-8'));
  });

  it('sqlite projection matches golden', async () => {
    const sql = projectSqlFromIr(await loadEcommerce(), 'sqlite');
    const path = resolve(goldenDir, 'ecommerce.sqlite.sql');
    if (UPDATE) {
      writeFileSync(path, sql);
      return;
    }
    expect(sql).toBe(readFileSync(path, 'utf-8'));
  });
});
