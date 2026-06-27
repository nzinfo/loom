import { describe, expect, it } from 'vitest';
import { load } from '../src/loader/index.js';
import { projectSqlFromIr } from '../src/projector/sql.js';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';

async function pg() {
  const { ir } = await load({ fs: buildBaseSchemaFs(), basePath: '' });
  return projectSqlFromIr(ir, 'pg');
}

describe('projector dialects', () => {
  it('pg: emits NUMERIC(18,4) for decimal, VARCHAR(n) for string', async () => {
    const sql = await pg();
    expect(sql).toContain('NUMERIC(18,4)');
    expect(sql).toMatch(/VARCHAR\(254\)/);
  });

  it('pg: emits BIGINT for bigint', async () => {
    expect(await pg()).toContain('BIGINT');
  });

  it('pg: uses qualified name base_core.users_base (spec §6.2)', async () => {
    expect(await pg()).toContain('CREATE TABLE base_core.users_base');
  });

  it('pg: emits CREATE VIEW users as a LEFT JOIN over users_ext (JSONB groups)', async () => {
    const sql = await pg();
    expect(sql).toContain('CREATE VIEW users');
    expect(sql).toMatch(
      /LEFT JOIN users_ext .* ON .*\.base_id_0 = u\.id AND .*\.source = '[0-9a-f]{16}'/,
    );
    expect(sql).toMatch(/\.values->>'nickname' AS nickname/);
  });

  it('pg: emits CREATE TYPE for enum scalars (spec §11)', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'platform/base/core/bigint.type.yaml':
        'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
      'platform/base/core/string.type.yaml':
        'version: loom-schema/v2\nname: string\nform: scalar\nproperties: []\n',
      'platform/base/core/status.type.yaml':
        'version: loom-schema/v2\nname: Status\nform: enum\nvariants: [active, inactive]\n',
      'platform/base/core/t.table.yaml':
        'version: loom-schema/v2\nname: T\ntable:\n  name: t\nfields:\n  - name: id\n    type: bigint\n    required: true\n  - name: status\n    type: base.core.Status\nprimary_key: [id]\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const sql = projectSqlFromIr(ir, 'pg');
    expect(sql).toContain('CREATE TYPE base_core_status AS ENUM');
    expect(sql).toContain('status base_core_status');
  });

  it('mysql: emits DECIMAL(18,4) and VARCHAR; enum as ENUM(...)', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'platform/base/core/bigint.type.yaml':
        'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
      'platform/base/core/decimal.type.yaml':
        'version: loom-schema/v2\nname: decimal\nform: scalar\nproperties:\n  - { {name: precision, type: integer, required: true, name: scale, type: integer, required: true} }\n',
      'platform/base/core/string.type.yaml':
        'version: loom-schema/v2\nname: string\nform: scalar\nproperties:\n  - { {name: max_length, type: integer, required: true} }\n',
      'platform/base/core/status.type.yaml':
        'version: loom-schema/v2\nname: Status\nform: enum\nvariants: [active, inactive]\n',
      'platform/base/core/money.type.yaml':
        'version: loom-schema/v2\nname: Money\nform: struct\nfields:\n  - name: amount\n    type:\n      ref: decimal\n      args: { precision: 18, scale: 4 }\n  - name: currency_code\n    type:\n      ref: string\n      args: { max_length: 3 }\n',
      'platform/base/core/email.type.yaml':
        'version: loom-schema/v2\nname: Email\nform: struct\nfields:\n  - name: value\n    type:\n      ref: string\n      args: { max_length: 254 }\n',
      'platform/base/core/t.table.yaml':
        'version: loom-schema/v2\nname: T\ntable:\n  name: t\nfields:\n  - name: id\n    type: bigint\n    required: true\n  - name: s\n    type: base.core.Status\n  - name: m\n    type: base.core.Money\n  - name: email\n    type: base.core.Email\nprimary_key: [id]\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const sql = projectSqlFromIr(ir, 'mysql');
    expect(sql).toContain('DECIMAL(18,4)');
    expect(sql).toMatch(/VARCHAR\(254\)/);
    expect(sql).toContain("s ENUM('active', 'inactive')");
  });

  it('sqlite: emits NUMERIC for decimal, TEXT for string, CHECK for enum', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'platform/base/core/bigint.type.yaml':
        'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
      'platform/base/core/decimal.type.yaml':
        'version: loom-schema/v2\nname: decimal\nform: scalar\nproperties:\n  - { {name: precision, type: integer, required: true, name: scale, type: integer, required: true} }\n',
      'platform/base/core/status.type.yaml':
        'version: loom-schema/v2\nname: Status\nform: enum\nvariants: [active, inactive]\n',
      'platform/base/core/money.type.yaml':
        'version: loom-schema/v2\nname: Money\nform: struct\nfields:\n  - name: amount\n    type:\n      ref: decimal\n      args: { precision: 18, scale: 4 }\n',
      'platform/base/core/t.table.yaml':
        'version: loom-schema/v2\nname: T\ntable:\n  name: t\nfields:\n  - name: id\n    type: bigint\n    required: true\n  - name: s\n    type: base.core.Status\n  - name: m\n    type: base.core.Money\nprimary_key: [id]\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const sql = projectSqlFromIr(ir, 'sqlite');
    expect(sql).toContain('NUMERIC');
    expect(sql).toContain('TEXT');
    expect(sql).toContain("CHECK (s IN ('active', 'inactive'))");
  });

  describe('enum variant metadata → structured comments', () => {
    // A schema with two enums: one carrying display_name/description metadata,
    // one bare (shorthand strings only).
    async function enumMetaFs() {
      const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
      return new MemoryFileSystem({
        'platform/base/core/bigint.type.yaml':
          'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
        'platform/base/core/string.type.yaml':
          'version: loom-schema/v2\nname: string\nform: scalar\nproperties: []\n',
        // Labeled enum (active has display_name; suspended has display+desc; plain has none)
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
        // Bare enum — no metadata → no comment emitted
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
    }

    it('pg: emits COMMENT ON TYPE with loom:enum body for labeled enum', async () => {
      const { ir } = await load({ fs: await enumMetaFs(), basePath: '' });
      const sql = projectSqlFromIr(ir, 'pg');
      expect(sql).toContain('CREATE TYPE base_core_status AS ENUM');
      expect(sql).toMatch(
        /COMMENT ON TYPE base_core_status IS 'loom:enum active=Active\|suspended=Suspended;account is frozen\|plain'/,
      );
      // Bare enum (Category) gets no COMMENT.
      expect(sql).not.toMatch(/COMMENT ON TYPE base_core_category/);
    });

    it('mysql: emits column COMMENT with loom:enum body for labeled enum', async () => {
      const { ir } = await load({ fs: await enumMetaFs(), basePath: '' });
      const sql = projectSqlFromIr(ir, 'mysql');
      expect(sql).toMatch(
        /status ENUM\([^)]*\)[^;]*COMMENT 'loom:enum active=Active\|suspended=Suspended;account is frozen\|plain'/,
      );
      // Bare enum column has no COMMENT clause.
      expect(sql).not.toMatch(/category ENUM[^;]*COMMENT/);
    });

    it('sqlite: emits -- loom:enum line above labeled enum column', async () => {
      const { ir } = await load({ fs: await enumMetaFs(), basePath: '' });
      const sql = projectSqlFromIr(ir, 'sqlite');
      expect(sql).toMatch(
        /-- loom:enum active=Active\|suspended=Suspended;account is frozen\|plain/,
      );
      expect(sql).toContain("CHECK (status IN ('active', 'suspended', 'plain'))");
      // Bare enum column has no loom:enum comment.
      expect(sql).not.toMatch(/-- loom:enum a=/);
    });

    it('carries metadata through PhysicalModel.enums', async () => {
      const { expandTables } = await import('../src/projector/expand.js');
      const { ir } = await load({ fs: await enumMetaFs(), basePath: '' });
      const model = expandTables(ir);
      const status = model.enums.get('type:base.core.Status');
      expect(status).toEqual({
        carrier: 'string',
        variants: [
          { value: 'active', display_name: 'Active' },
          { value: 'suspended', display_name: 'Suspended', description: 'account is frozen' },
          { value: 'plain' },
        ],
      });
      // Bare enum still registered, values only.
      const category = model.enums.get('type:base.core.Category');
      expect(category).toEqual({
        carrier: 'string',
        variants: [{ value: 'a' }, { value: 'b' }],
      });
    });
  });

  it('is deterministic (stable under re-run)', async () => {
    const a = await pg();
    const b = await pg();
    expect(a).toBe(b);
  });
});
