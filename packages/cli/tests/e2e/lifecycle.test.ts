/**
 * E2E lifecycle test — full workflow from init to rm.
 *
 * Exercises the real CLI entry point as a subprocess, covering main.ts
 * argument parsing and command dispatch. Each test gets a fresh temp dir.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpDirs, runLoom, tmpProject } from './helpers.js';

afterAll(() => cleanupTmpDirs());

describe('e2e: full lifecycle', () => {
  it('init → check → new → add → show → move → project → rm', async () => {
    const dir = tmpProject();

    // 1. init — creates 20 files (18 scalars + table + entity)
    const init = await runLoom(['init', dir, '--system', 'shop', '--module', 'core']);
    expect(init.exitCode).toBe(0);
    const files = fs.readdirSync(path.join(dir, 'platform/shop/core'));
    expect(files.length).toBe(20);
    expect(files).toContain('bigint.type.yaml');
    expect(files).toContain('items.table.yaml');
    expect(files).toContain('item.entity.yaml');

    // 2. check — passes
    const check1 = await runLoom(['check', dir]);
    expect(check1.exitCode).toBe(0);

    // 3. new type — creates a struct
    const newType = await runLoom(['new', 'type', dir, 'shop.core.Address', '--form', 'struct']);
    expect(newType.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'platform/shop/core/address.type.yaml'))).toBe(true);

    // 4. add field city
    const add1 = await runLoom([
      'add',
      'field',
      dir,
      'type:shop.core.Address',
      'city',
      'string',
      '--args',
      'max_length=64',
    ]);
    expect(add1.exitCode).toBe(0);

    // 5. add field country (required)
    const add2 = await runLoom([
      'add',
      'field',
      dir,
      'type:shop.core.Address',
      'country',
      'string',
      '--args',
      'max_length=2',
      '--required',
    ]);
    expect(add2.exitCode).toBe(0);

    // 6. show type — output contains city/country
    const show = await runLoom(['show', 'type', dir, 'type:shop.core.Address']);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('city');
    expect(show.stdout).toContain('country');

    // 7. move field country to first
    const move = await runLoom([
      'move',
      'field',
      dir,
      'type:shop.core.Address',
      'country',
      '--first',
    ]);
    expect(move.exitCode).toBe(0);

    // 8. check — still passes after edits
    const check2 = await runLoom(['check', dir]);
    expect(check2.exitCode).toBe(0);

    // 9. project sql — generates DDL
    const project = await runLoom(['project', 'sql', '--dialect', 'pg', dir]);
    expect(project.exitCode).toBe(0);
    expect(project.stdout).toContain('CREATE TABLE');

    // 10. rm type — deletes the file
    const rm = await runLoom(['rm', 'type', dir, 'shop.core.Address']);
    expect(rm.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'platform/shop/core/address.type.yaml'))).toBe(false);

    // 11. check — still passes after deletion
    const check3 = await runLoom(['check', dir]);
    expect(check3.exitCode).toBe(0);
  });

  it('init --no-example creates only scalars', async () => {
    const dir = tmpProject();
    const init = await runLoom(['init', dir, '--system', 'test', '--no-example']);
    expect(init.exitCode).toBe(0);
    const files = fs.readdirSync(path.join(dir, 'platform/test/core'));
    // 18 scalars only, no table/entity
    expect(files.filter((f) => f.endsWith('.type.yaml')).length).toBe(18);
    expect(files.some((f) => f.endsWith('.table.yaml'))).toBe(false);
    expect(files.some((f) => f.endsWith('.entity.yaml'))).toBe(false);
  });

  it('init --force overwrites existing directory', async () => {
    const dir = tmpProject();
    // First init
    await runLoom(['init', dir, '--system', 'shop']);
    // Second init without --force should fail
    const fail = await runLoom(['init', dir, '--system', 'shop']);
    expect(fail.exitCode).toBe(3);
    // With --force should succeed
    const force = await runLoom(['init', dir, '--system', 'shop', '--force']);
    expect(force.exitCode).toBe(0);
  });
});
