import { describe, expect, it } from 'vitest';
import { expandTables, load } from '@loom/core';
import type { FileSystem } from '@loom/core';
import { projectModelJson } from '../src/commands/project_model.js';

/** Minimal in-memory FileSystem for unit tests (mirrors core's fixture). */
class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Uint8Array>();
  constructor(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) {
      this.files.set(k.replace(/\\/g, '/'), new TextEncoder().encode(v));
    }
  }
  async readFile(p: string): Promise<Uint8Array> {
    const buf = this.files.get(p.replace(/\\/g, '/'));
    if (!buf) throw new Error(`ENOENT: ${p}`);
    return buf;
  }
  async *listFiles(dir: string): AsyncIterable<string> {
    const normalized = dir.replace(/\\/g, '/').replace(/\/$/, '');
    const prefix = normalized === '' ? '' : `${normalized}/`;
    for (const key of this.files.keys()) {
      if ((key === normalized || key.startsWith(prefix)) && /\.(ya?ml)$/.test(key)) {
        yield key;
      }
    }
  }
  async stat(p: string): Promise<{ mtimeMs: number; size: number }> {
    const buf = this.files.get(p.replace(/\\/g, '/'));
    if (!buf) throw new Error(`ENOENT: ${p}`);
    return { mtimeMs: 0, size: buf.byteLength };
  }
}

/**
 * Unit tests for project-model-schema JSON serialization, focusing on the
 * enum `variants`/`values` fields added when variant metadata (display_name/
 * description) was threaded through.
 */

async function buildModelJson(dialect: 'pg' | 'mysql' | 'sqlite') {
  const fs = new MemoryFileSystem({
    'platform/base/core/bigint.type.yaml':
      'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
    'platform/base/core/string.type.yaml':
      'version: loom-schema/v2\nname: string\nform: scalar\nproperties: []\n',
    // Labeled enum: active has display_name; suspended has display+desc; plain bare.
    'platform/base/core/status.type.yaml': `version: loom-schema/v2
name: Status
form: enum
variants:
  - value: active
    display_name: Active
  - value: suspended
    display_name: Suspended
    description: account is frozen
  - value: plain
`,
    // Bare enum — no metadata.
    'platform/base/core/category.type.yaml':
      'version: loom-schema/v2\nname: Category\nform: enum\nvariants: [a, b]\n',
    'platform/base/core/t.table.yaml': `version: loom-schema/v2
name: T
table:
  name: t
fields:
  - name: id
    type: bigint
    required: true
  - name: status
    type: base.core.Status
  - name: category
    type: base.core.Category
primary_key: [id]
`,
  });
  const { ir } = await load({ fs, basePath: '' });
  const model = expandTables(ir);
  return projectModelJson(ir, model, dialect);
}

describe('projectModelJson — enum serialization', () => {
  it('emits both values[] (backward compat) and variants[] (with metadata)', async () => {
    const json = await buildModelJson('pg');
    const status = json.enums.find((e) => e.name === 'Status');
    expect(status).toBeDefined();

    // values: plain string list (old consumers).
    expect(status!.values).toEqual(['active', 'suspended', 'plain']);

    // variants: objects with optional display_name/description.
    expect(status!.variants).toEqual([
      { value: 'active', display_name: 'Active' },
      { value: 'suspended', display_name: 'Suspended', description: 'account is frozen' },
      { value: 'plain' },
    ]);
  });

  it('emits variants without metadata keys for bare-string enums', async () => {
    const json = await buildModelJson('pg');
    const category = json.enums.find((e) => e.name === 'Category');
    expect(category).toBeDefined();
    expect(category!.values).toEqual(['a', 'b']);
    expect(category!.variants).toEqual([{ value: 'a' }, { value: 'b' }]);
  });

  it('preserves the enum identity (for enumRef lookup) in JSON output', async () => {
    const json = await buildModelJson('mysql');
    const status = json.enums.find((e) => e.name === 'Status');
    expect(status!.identity).toBe('type:base.core.Status');
    // A column referencing this enum should carry the matching enumRef.
    const t = json.tables.find((tbl) => tbl.name === 't');
    const statusCol = t!.columns.find((c) => c.name === 'status');
    expect(statusCol!.enumRef).toBe('type:base.core.Status');
  });

  it('emits carrier field in enum output (default string)', async () => {
    const json = await buildModelJson('pg');
    const status = json.enums.find((e) => e.name === 'Status');
    expect(status!.carrier).toBe('string');
    const category = json.enums.find((e) => e.name === 'Category');
    expect(category!.carrier).toBe('string');
  });

  it('is consistent across dialects (enum shape does not depend on dialect)', async () => {
    const pg = await buildModelJson('pg');
    const mysql = await buildModelJson('mysql');
    const sqlite = await buildModelJson('sqlite');
    const pick = (j: typeof pg) =>
      j.enums.find((e) => e.name === 'Status')!.variants;
    expect(pick(pg)).toEqual(pick(mysql));
    expect(pick(pg)).toEqual(pick(sqlite));
  });
});
