/**
 * E2E write tests — field editing operations on temp projects.
 *
 * Each test creates a fresh project via init, then exercises mutation
 * commands (add/rm/move/order) and verifies the results.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpDirs, runLoom, tmpProject } from './helpers.js';

afterAll(() => cleanupTmpDirs());

/** Create a temp project with a struct type that has 3 fields. */
async function setupStructWithFields(): Promise<string> {
  const dir = tmpProject();
  await runLoom(['init', dir, '--system', 'shop', '--module', 'core', '--no-example']);
  await runLoom(['new', 'type', dir, 'shop.core.Address', '--form', 'struct']);
  await runLoom(['add', 'field', dir, 'type:shop.core.Address', 'city', 'string', '--args', 'max_length=64']);
  await runLoom(['add', 'field', dir, 'type:shop.core.Address', 'zip', 'string', '--args', 'max_length=10']);
  await runLoom(['add', 'field', dir, 'type:shop.core.Address', 'country', 'string', '--args', 'max_length=2', '--required']);
  return dir;
}

function readFields(dir: string): string[] {
  const content = fs.readFileSync(
    path.join(dir, 'platform/shop/core/address.type.yaml'),
    'utf-8',
  );
  // Extract field names in order.
  const names: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s+- name: (\w+)/);
    if (m) names.push(m[1]!);
  }
  return names;
}

describe('e2e: add field', () => {
  it('adds a scalar field with args', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom([
      'add', 'field', dir, 'type:shop.core.Address', 'state', 'string', '--args', 'max_length=32',
    ]);
    expect(r.exitCode).toBe(0);
    expect(readFields(dir)).toContain('state');
  });

  it('rejects duplicate field name', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom([
      'add', 'field', dir, 'type:shop.core.Address', 'city', 'string',
    ]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('already exists');
  });
});

describe('e2e: rm field', () => {
  it('removes a field', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom(['rm', 'field', dir, 'type:shop.core.Address', 'zip']);
    expect(r.exitCode).toBe(0);
    const names = readFields(dir);
    expect(names).not.toContain('zip');
    expect(names).toContain('city');
  });

  it('returns error for non-existent field', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom(['rm', 'field', dir, 'type:shop.core.Address', 'nope']);
    expect(r.exitCode).toBe(3);
  });
});

describe('e2e: move field', () => {
  it('moves field to first position', async () => {
    const dir = await setupStructWithFields();
    // value, city, zip, country → move country to first
    const r = await runLoom(['move', 'field', dir, 'type:shop.core.Address', 'country', '--first']);
    expect(r.exitCode).toBe(0);
    const names = readFields(dir);
    expect(names[0]).toBe('country');
  });

  it('moves field after another', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom(['move', 'field', dir, 'type:shop.core.Address', 'country', '--after', 'city']);
    expect(r.exitCode).toBe(0);
    const names = readFields(dir);
    const cityIdx = names.indexOf('city');
    const countryIdx = names.indexOf('country');
    expect(countryIdx).toBe(cityIdx + 1);
  });

  it('moves field to last position', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom(['move', 'field', dir, 'type:shop.core.Address', 'value', '--last']);
    expect(r.exitCode).toBe(0);
    const names = readFields(dir);
    expect(names[names.length - 1]).toBe('value');
  });
});

describe('e2e: order fields', () => {
  it('reorders all fields', async () => {
    const dir = await setupStructWithFields();
    // Current: value, city, zip, country
    const r = await runLoom([
      'order', 'fields', dir, 'type:shop.core.Address', 'country', 'zip', 'city', 'value',
    ]);
    expect(r.exitCode).toBe(0);
    expect(readFields(dir)).toEqual(['country', 'zip', 'city', 'value']);
  });

  it('rejects incomplete order (missing field)', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom([
      'order', 'fields', dir, 'type:shop.core.Address', 'value', 'city', 'zip',
      // missing 'country'
    ]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('missing');
  });

  it('rejects extra field in order', async () => {
    const dir = await setupStructWithFields();
    const r = await runLoom([
      'order', 'fields', dir, 'type:shop.core.Address',
      'value', 'city', 'zip', 'country', 'extra',
    ]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('unknown');
  });
});

describe('e2e: rm node with dependency check', () => {
  it('blocks rm type when referenced by a table', async () => {
    const dir = tmpProject();
    await runLoom(['init', dir, '--system', 'shop', '--module', 'core', '--no-example']);
    await runLoom(['new', 'type', dir, 'shop.core.Money', '--form', 'struct']);
    await runLoom([
      'add', 'field', dir, 'type:shop.core.Money', 'amount',
      'string', '--args', 'max_length=10', '--required',
    ]);

    // Create a table referencing Money via a field
    await runLoom(['new', 'table', dir, 'shop.core.Orders']);
    await runLoom([
      'add', 'field', dir, 'table:shop.core.Orders', 'total', 'shop.core.Money',
    ]);

    // rm type should block (table:shop.core.Orders depends on type:shop.core.Money)
    const blocked = await runLoom(['rm', 'type', dir, 'shop.core.Money']);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.stderr).toContain('referenced');

    // --force overrides
    const forced = await runLoom(['rm', 'type', dir, 'shop.core.Money', '--force']);
    expect(forced.exitCode).toBe(0);
  });
});

describe('e2e: new entity + extension', () => {
  it('creates entity and extension, then shows groups', async () => {
    const dir = tmpProject();
    await runLoom(['init', dir, '--system', 'shop', '--module', 'core', '--no-example']);
    await runLoom(['new', 'table', dir, 'shop.core.Products']);
    await runLoom([
      'new', 'entity', dir, 'shop.core.Product', '--table', 'table:shop.core.Products',
    ]);

    // entity file should exist
    expect(fs.existsSync(path.join(dir, 'platform/shop/core/product.entity.yaml'))).toBe(true);

    // Create extension from platform owner
    const ext = await runLoom([
      'new', 'extension', dir,
      '--entity', 'entity:shop.core.Product',
      '--group', 'inventory',
    ]);
    expect(ext.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'platform/shop/core/inventory.ext.yaml'))).toBe(true);

    // Create extension from ext provider
    const ext2 = await runLoom([
      'new', 'extension', dir,
      '--entity', 'entity:shop.core.Product',
      '--group', 'pricing',
      '--owner', 'ext:vendor-x',
    ]);
    expect(ext2.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'ext/vendor-x/shop/core/pricing.ext.yaml'))).toBe(true);

    // Add field to extension via ext: target
    const addExt = await runLoom([
      'add', 'field', dir,
      'ext:entity:shop.core.Product::inventory',
      'sku', 'string', '--args', 'max_length=64',
    ]);
    expect(addExt.exitCode).toBe(0);
    const extContent = fs.readFileSync(
      path.join(dir, 'platform/shop/core/inventory.ext.yaml'), 'utf-8',
    );
    expect(extContent).toContain('sku');

    // rm extension (specific group)
    const rmExt = await runLoom([
      'rm', 'extension', dir,
      '--entity', 'entity:shop.core.Product',
      '--group', 'inventory',
    ]);
    expect(rmExt.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'platform/shop/core/inventory.ext.yaml'))).toBe(false);

    // rm extension (all remaining)
    const rmAll = await runLoom([
      'rm', 'extension', dir,
      '--entity', 'entity:shop.core.Product',
    ]);
    expect(rmAll.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'ext/vendor-x/shop/core/pricing.ext.yaml'))).toBe(false);
  });
});

describe('e2e: rm table + entity', () => {
  it('removes table and entity', async () => {
    const dir = tmpProject();
    await runLoom(['init', dir, '--system', 'shop', '--module', 'core', '--no-example']);
    await runLoom(['new', 'table', dir, 'shop.core.Standalone']);
    await runLoom(['new', 'entity', dir, 'shop.core.Thing', '--table', 'table:shop.core.Standalone']);

    // rm entity first (no deps on it)
    const rmEntity = await runLoom(['rm', 'entity', dir, 'shop.core.Thing']);
    expect(rmEntity.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'platform/shop/core/thing.entity.yaml'))).toBe(false);

    // rm table
    const rmTable = await runLoom(['rm', 'table', dir, 'shop.core.Standalone']);
    expect(rmTable.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'platform/shop/core/standalone.table.yaml'))).toBe(false);
  });
});

describe('e2e: move field --before', () => {
  it('moves field before another', async () => {
    const dir = await setupStructWithFields();
    // Current: value, city, zip, country
    const r = await runLoom([
      'move', 'field', dir, 'type:shop.core.Address', 'country', '--before', 'city',
    ]);
    expect(r.exitCode).toBe(0);
    const names = readFields(dir);
    const cityIdx = names.indexOf('city');
    const countryIdx = names.indexOf('country');
    expect(countryIdx).toBe(cityIdx - 1);
  });
});
