/**
 * E2E read tests — query commands against examples/product/.
 *
 * Tests both human-readable and --json output modes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpDirs, repoRoot, runLoom, runLoomJson } from './helpers.js';

afterAll(() => cleanupTmpDirs());

const productDir = repoRoot('examples/product');

describe('e2e: read commands', () => {
  it('list entities shows Product', async () => {
    const r = await runLoom(['list', 'entities', productDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('entity:shop.core.Product');
  });

  it('list extensions shows 3 groups', async () => {
    const r = await runLoom(['list', 'extensions', productDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('inventory');
    expect(r.stdout).toContain('pricing');
    expect(r.stdout).toContain('logistics');
  });

  it('list types --json returns array', async () => {
    const { json } = await runLoomJson(['list', 'types', productDir]);
    expect(Array.isArray(json)).toBe(true);
    expect((json as unknown[]).length).toBeGreaterThan(0);
  });

  it('show entity displays groups with owner', async () => {
    const r = await runLoom(['show', 'entity', productDir, 'entity:shop.core.Product']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('group: inventory (ext:provider-a)');
    expect(r.stdout).toContain('group: pricing (ext:provider-b)');
    expect(r.stdout).toContain('group: logistics (ext:provider-b)');
  });

  it('show type displays struct fields', async () => {
    const r = await runLoom(['show', 'type', productDir, 'type:shop.core.Money']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('form: struct');
    expect(r.stdout).toContain('amount');
    expect(r.stdout).toContain('currency_code');
  });

  it('show graph displays dependency edges', async () => {
    const r = await runLoom(['show', 'graph', productDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('table:shop.core.Products');
    expect(r.stdout).toContain('type:shop.core.Money');
  });

  it('show graph --json returns nodes + edges', async () => {
    const { json } = await runLoomJson(['show', 'graph', productDir]);
    const data = json as { nodes: unknown[]; edges: unknown[] };
    expect(data.nodes.length).toBeGreaterThan(0);
    expect(data.edges.length).toBeGreaterThan(0);
  });

  it('project model outputs JSON with tables + extensions', async () => {
    const r = await runLoom(['project', 'model', '--dialect', 'pg', productDir]);
    expect(r.exitCode).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.dialect).toBe('pg');
    expect(data.tables.length).toBeGreaterThan(0);
    expect(data.extensions.length).toBeGreaterThan(0);
    // Verify a column has sqlType
    const col = data.tables[0].columns[0];
    expect(col.sqlType).toBeDefined();
    expect(col.name).toBeDefined();
  });

  it('check --json returns ok:true', async () => {
    const { json } = await runLoomJson(['check', productDir]);
    expect(json).toEqual({ ok: true, path: productDir });
  });

  it('project sql --dialect pg generates valid DDL', async () => {
    const r = await runLoom(['project', 'sql', '--dialect', 'pg', productDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('CREATE TABLE');
    expect(r.stdout).toContain('CREATE VIEW');
  });

  it('project sql --dialect mysql generates MySQL DDL', async () => {
    const r = await runLoom(['project', 'sql', '--dialect', 'mysql', productDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('DATETIME(6)');
  });

  it('show entity returns 64 for unknown entity', async () => {
    const r = await runLoom(['show', 'entity', productDir, 'entity:shop.core.Nope']);
    expect(r.exitCode).toBe(64);
  });

  it('project sql returns 64 without --dialect', async () => {
    const r = await runLoom(['project', 'sql', productDir]);
    expect(r.exitCode).toBe(64);
  });
});
