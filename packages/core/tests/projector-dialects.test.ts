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

  it('pg: emits CREATE VIEW users as a pivot over users_ext (spec §7.4)', async () => {
    const sql = await pg();
    expect(sql).toContain('CREATE VIEW users');
    expect(sql).toMatch(/FROM users_ext e WHERE e\.base_id = u\.id AND e\.field_name = 'nickname'/);
  });

  it('pg: emits CREATE TYPE for enum scalars (spec §11)', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'platform/base/core/base_types.yaml':
        'version: loom-schema/v2\nkind: base_types\nscalars:\n  - name: bigint\n    properties: []\n  - name: string\n    properties: []\n',
      'platform/base/core/MANIFEST.yaml':
        'version: loom-schema/v2\nkind: module_manifest\nsystem: base\nmodule: core\nphysical_schema: base_core\n',
      'platform/base/core/value_type/status.yaml':
        'version: loom-schema/v2\nkind: value_type\nname: Status\nvariants: [active, inactive]\n',
      'platform/base/core/table/t.yaml':
        'version: loom-schema/v2\nkind: table\nname: T\ntable:\n  name: t\n  extension:\n    strategy: none\nfields:\n  - name: id\n    type: bigint\n    required: true\n  - name: status\n    type: base.core.Status\nprimary_key: [id]\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const sql = projectSqlFromIr(ir, 'pg');
    expect(sql).toContain('CREATE TYPE base_core_status AS ENUM');
    expect(sql).toContain('status base_core_status');
  });

  it('mysql: emits DECIMAL(18,4) and VARCHAR; enum as ENUM(...)', async () => {
    const { MemoryFileSystem } = await import('./fixtures/memory_fs.js');
    const fs = new MemoryFileSystem({
      'platform/base/core/base_types.yaml':
        'version: loom-schema/v2\nkind: base_types\nscalars:\n  - name: bigint\n    properties: []\n  - name: decimal\n    properties:\n      - name: precision\n        type: integer\n        required: true\n      - name: scale\n        type: integer\n        required: true\n  - name: string\n    properties:\n      - name: max_length\n        type: integer\n        required: true\n',
      'platform/base/core/MANIFEST.yaml':
        'version: loom-schema/v2\nkind: module_manifest\nsystem: base\nmodule: core\nphysical_schema: base_core\n',
      'platform/base/core/value_type/status.yaml':
        'version: loom-schema/v2\nkind: value_type\nname: Status\nvariants: [active, inactive]\n',
      'platform/base/core/value_type/money.yaml':
        'version: loom-schema/v2\nkind: value_type\nname: Money\nfields:\n  - name: amount\n    type:\n      ref: decimal\n      args: { precision: 18, scale: 4 }\n  - name: currency_code\n    type:\n      ref: string\n      args: { max_length: 3 }\n',
      'platform/base/core/value_type/email.yaml':
        'version: loom-schema/v2\nkind: value_type\nname: Email\nfields:\n  - name: value\n    type:\n      ref: string\n      args: { max_length: 254 }\n',
      'platform/base/core/table/t.yaml':
        'version: loom-schema/v2\nkind: table\nname: T\ntable:\n  name: t\n  extension:\n    strategy: none\nfields:\n  - name: id\n    type: bigint\n    required: true\n  - name: s\n    type: base.core.Status\n  - name: m\n    type: base.core.Money\n  - name: email\n    type: base.core.Email\nprimary_key: [id]\n',
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
      'platform/base/core/base_types.yaml':
        'version: loom-schema/v2\nkind: base_types\nscalars:\n  - name: bigint\n    properties: []\n  - name: decimal\n    properties:\n      - name: precision\n        type: integer\n        required: true\n      - name: scale\n        type: integer\n        required: true\n',
      'platform/base/core/MANIFEST.yaml':
        'version: loom-schema/v2\nkind: module_manifest\nsystem: base\nmodule: core\nphysical_schema: base_core\n',
      'platform/base/core/value_type/status.yaml':
        'version: loom-schema/v2\nkind: value_type\nname: Status\nvariants: [active, inactive]\n',
      'platform/base/core/value_type/money.yaml':
        'version: loom-schema/v2\nkind: value_type\nname: Money\nfields:\n  - name: amount\n    type:\n      ref: decimal\n      args: { precision: 18, scale: 4 }\n',
      'platform/base/core/table/t.yaml':
        'version: loom-schema/v2\nkind: table\nname: T\ntable:\n  name: t\n  extension:\n    strategy: none\nfields:\n  - name: id\n    type: bigint\n    required: true\n  - name: s\n    type: base.core.Status\n  - name: m\n    type: base.core.Money\nprimary_key: [id]\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const sql = projectSqlFromIr(ir, 'sqlite');
    expect(sql).toContain('NUMERIC');
    expect(sql).toContain('TEXT');
    expect(sql).toContain("CHECK (s IN ('active', 'inactive'))");
  });

  it('is deterministic (stable under re-run)', async () => {
    const a = await pg();
    const b = await pg();
    expect(a).toBe(b);
  });
});
