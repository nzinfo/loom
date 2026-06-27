/**
 * Tests for ext strategy decoupling (2026-06-24-ext-strategy-decoupling.md).
 *
 * Covers:
 *   - ext.strategy: sidecar_jsonb (default + explicit)
 *   - ext.strategy: new_table (FK auto-injection, custom columns)
 *   - ext.table (explicit table name override)
 *   - table.default_ext_table (designer suggestion)
 *   - table.extensible (boolean flag)
 *   - sourceHash (xxHash64 computation + population)
 *   - sidecar table name priority (ext > table default > auto-derive)
 *   - FK column auto-injection (reuse base PK names + types)
 */
import { describe, expect, it } from 'vitest';
import { load } from '../src/loader/index.js';
import { expandTables } from '../src/projector/expand.js';
import { MemoryFileSystem } from './fixtures/memory_fs.js';

// ---- Base type files reused across tests ----
const BASE_TYPES: Record<string, string> = {
  'platform/base/core/bigint.type.yaml':
    'version: loom-schema/v2\nname: bigint\nform: scalar\nproperties: []\n',
  'platform/base/core/string.type.yaml':
    'version: loom-schema/v2\nname: string\nform: scalar\nproperties: [max_length]\n',
  'platform/base/core/decimal.type.yaml':
    'version: loom-schema/v2\nname: decimal\nform: scalar\nproperties: [precision, scale]\n',
  'platform/base/core/uuid.type.yaml':
    'version: loom-schema/v2\nname: uuid\nform: scalar\nproperties: []\n',
};

/**
 * Build a minimal project with one extensible table + entity + ext file.
 * The table PK type and ext strategy are parameterized.
 */
function buildFs(opts: {
  pkType?: string;
  extensible?: boolean;
  defaultExtTable?: string;
  extStrategy?: 'sidecar_jsonb' | 'new_table';
  extTable?: string;
  extGroup?: string;
  extFields?: string;
}): MemoryFileSystem {
  const pkType = opts.pkType ?? 'bigint';
  const files: Record<string, string> = { ...BASE_TYPES };

  // Table
  const tableLines = [
    'version: loom-schema/v2',
    'name: Products',
    'using:',
    '  - base.core.*',
    'table:',
    '  name: products_base',
  ];
  if (opts.extensible === true) tableLines.push('extensible: true');
  if (opts.defaultExtTable) tableLines.push(`default_ext_table: ${opts.defaultExtTable}`);
  tableLines.push(
    'fields:',
    '  - name: id',
    `    type: ${pkType}`,
    '    required: true',
    'primary_key: [id]',
  );
  files['platform/shop/core/products.table.yaml'] = `${tableLines.join('\n')}\n`;

  // Entity
  files['platform/shop/core/product.entity.yaml'] = `${[
    'version: loom-schema/v2',
    'name: Product',
    'primary_table: table:shop.core.Products',
    'view: products',
  ].join('\n')}\n`;

  // Ext file (if strategy given or default)
  // Always create an ext file when extensible is true (to test default strategy)
  if (opts.extStrategy || opts.extensible === true) {
    const extLines = ['version: loom-schema/v2', 'entity: entity:shop.core.Product'];
    if (opts.extStrategy) extLines.push(`strategy: ${opts.extStrategy}`);
    if (opts.extTable) extLines.push(`table: ${opts.extTable}`);
    if (opts.extGroup) extLines.push(`group: ${opts.extGroup}`);
    extLines.push('using:', '  - base.core.*', 'fields:');
    if (opts.extFields) {
      extLines.push(...opts.extFields.split('\n'));
    } else {
      extLines.push('  - name: shelf_location', '    type: string');
    }
    files['platform/shop/core/product_meta.ext.yaml'] = `${extLines.join('\n')}\n`;
  }

  return new MemoryFileSystem(files);
}

describe('ext strategy: sidecar_jsonb', () => {
  it('defaults to sidecar_jsonb when strategy is omitted', async () => {
    const fs = buildFs({ extensible: true });
    const { ir } = await load({ fs, basePath: '' });
    const extEntries = ir.extensionFields.get('entity:shop.core.Product');
    expect(extEntries).toBeDefined();
    expect(extEntries?.length).toBeGreaterThan(0);
    expect(extEntries?.[0]?.strategy).toBe('sidecar_jsonb');
  });

  it('reads strategy: sidecar_jsonb explicitly', async () => {
    const fs = buildFs({ extensible: true, extStrategy: 'sidecar_jsonb' });
    const { ir } = await load({ fs, basePath: '' });
    const extEntries = ir.extensionFields.get('entity:shop.core.Product');
    expect(extEntries?.[0]?.strategy).toBe('sidecar_jsonb');
  });

  it('populates sourceHash for sidecar_jsonb fields', async () => {
    const fs = buildFs({ extensible: true, extStrategy: 'sidecar_jsonb', extGroup: 'meta' });
    const { ir } = await load({ fs, basePath: '' });
    const extEntries = ir.extensionFields.get('entity:shop.core.Product');
    const entry = extEntries?.[0];
    expect(entry).toBeDefined();
    expect(entry?.sourceHash).toBeDefined();
    expect(entry.sourceHash).toHaveLength(16); // xxHash64 = 16 hex chars
    expect(entry.sourceHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('sourceHash is deterministic — same inputs produce same hash', async () => {
    const fs1 = buildFs({ extensible: true, extStrategy: 'sidecar_jsonb', extGroup: 'meta' });
    const fs2 = buildFs({ extensible: true, extStrategy: 'sidecar_jsonb', extGroup: 'meta' });
    const { ir: ir1 } = await load({ fs: fs1, basePath: '' });
    const { ir: ir2 } = await load({ fs: fs2, basePath: '' });
    const h1 = ir1.extensionFields.get('entity:shop.core.Product')?.[0]?.sourceHash;
    const h2 = ir2.extensionFields.get('entity:shop.core.Product')?.[0]?.sourceHash;
    expect(h1).toBe(h2);
  });

  it('sourceHash differs for different groups', async () => {
    const fs = new MemoryFileSystem({
      ...BASE_TYPES,
      'platform/shop/core/products.table.yaml':
        'version: loom-schema/v2\nname: Products\nusing:\n  - base.core.*\ntable:\n  name: products_base\nextensible: true\nfields:\n  - name: id\n    type: bigint\n    required: true\nprimary_key: [id]\n',
      'platform/shop/core/product.entity.yaml':
        'version: loom-schema/v2\nname: Product\nprimary_table: table:shop.core.Products\nview: products\n',
      'platform/shop/core/product_meta.ext.yaml':
        'version: loom-schema/v2\nentity: entity:shop.core.Product\nstrategy: sidecar_jsonb\ngroup: meta\nusing:\n  - base.core.*\nfields:\n  - name: shelf\n    type: string\n',
      'platform/shop/core/product_audit.ext.yaml':
        'version: loom-schema/v2\nentity: entity:shop.core.Product\nstrategy: sidecar_jsonb\ngroup: audit\nusing:\n  - base.core.*\nfields:\n  - name: note\n    type: string\n',
    });
    const { ir } = await load({ fs, basePath: '' });
    const entries = ir.extensionFields.get('entity:shop.core.Product');
    expect(entries).toBeDefined();
    const metaHash = entries?.find((e) => e.group === 'meta')?.sourceHash;
    const auditHash = entries.find((e) => e.group === 'audit')?.sourceHash;
    expect(metaHash).not.toBe(auditHash);
  });

  it('does NOT populate sourceHash for new_table strategy', async () => {
    const fs = buildFs({ extensible: true, extStrategy: 'new_table', extTable: 'product_inv' });
    const { ir } = await load({ fs, basePath: '' });
    const extEntries = ir.extensionFields.get('entity:shop.core.Product');
    expect(extEntries?.[0]?.sourceHash).toBeUndefined();
  });
});

describe('ext strategy: new_table', () => {
  it('reads strategy: new_table', async () => {
    const fs = buildFs({ extensible: true, extStrategy: 'new_table', extTable: 'product_inv' });
    const { ir } = await load({ fs, basePath: '' });
    const extEntries = ir.extensionFields.get('entity:shop.core.Product');
    expect(extEntries?.[0]?.strategy).toBe('new_table');
    expect(extEntries?.[0]?.tableName).toBe('product_inv');
  });

  it('auto-injects FK columns from base PK (single PK: bigint)', async () => {
    const fs = buildFs({
      extensible: true,
      extStrategy: 'new_table',
      extTable: 'product_inv',
      pkType: 'bigint',
      extFields: '  - name: sku\n    type: string\n  - name: stock_qty\n    type: bigint',
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const extTable = phys.tables.find((t) => t.name === 'product_inv');
    expect(extTable).toBeDefined();
    // FK column 'id' auto-injected (reuses base PK name)
    const colNames = extTable?.columns.map((c) => c.name);
    expect(colNames).toContain('id');
    // FK column has correct type
    const idCol = extTable?.columns.find((c) => c.name === 'id');
    expect(idCol?.scalar).toBe('bigint');
    expect(idCol?.required).toBe(true);
    // Data columns present
    expect(colNames).toContain('sku');
    expect(colNames).toContain('stock_qty');
  });

  it('auto-injects FK columns from base PK (single PK: uuid)', async () => {
    const fs = buildFs({
      extensible: true,
      extStrategy: 'new_table',
      extTable: 'product_inv',
      pkType: 'uuid',
      extFields: '  - name: sku\n    type: string',
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const extTable = phys.tables.find((t) => t.name === 'product_inv');
    const idCol = extTable?.columns.find((c) => c.name === 'id');
    expect(idCol?.scalar).toBe('uuid');
  });

  it('generates FOREIGN KEY constraint for new_table ext', async () => {
    const fs = buildFs({
      extensible: true,
      extStrategy: 'new_table',
      extTable: 'product_inv',
      extFields: '  - name: sku\n    type: string',
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const extTable = phys.tables.find((t) => t.name === 'product_inv');
    expect(extTable?.foreignKeys.length).toBe(1);
    const fk = extTable?.foreignKeys[0];
    expect(fk).toBeDefined();
    expect(fk?.columns).toEqual(['id']);
    expect(fk?.refColumns).toEqual(['id']);
    expect(fk.refTable).toContain('products_base');
  });

  it('sets strategy to new_table on the generated PhysicalTable', async () => {
    const fs = buildFs({
      extensible: true,
      extStrategy: 'new_table',
      extTable: 'product_inv',
      extFields: '  - name: sku\n    type: string',
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const extTable = phys.tables.find((t) => t.name === 'product_inv');
    expect(extTable?.strategy).toBe('new_table');
  });
});

describe('table.default_ext_table', () => {
  it('reads default_ext_table from table', async () => {
    const fs = buildFs({
      extensible: true,
      defaultExtTable: 'custom_ext',
      extStrategy: 'sidecar_jsonb',
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const productsTable = phys.tables.find((t) => t.name === 'products_base');
    expect(productsTable?.extTableName).toBe('custom_ext');
  });

  it('falls back to <table_name>_ext when no default_ext_table', async () => {
    const fs = buildFs({
      extensible: true,
      extStrategy: 'sidecar_jsonb',
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const productsTable = phys.tables.find((t) => t.name === 'products_base');
    expect(productsTable?.extTableName).toBe('products_base_ext');
  });

  it('ext-declared table name overrides table default_ext_table', async () => {
    const fs = buildFs({
      extensible: true,
      defaultExtTable: 'default_ext',
      extStrategy: 'sidecar_jsonb',
      extTable: 'override_ext',
    });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const productsTable = phys.tables.find((t) => t.name === 'products_base');
    expect(productsTable?.extTableName).toBe('override_ext');
  });
});

describe('table.extensible flag', () => {
  it('extensible: true → strategy resolves to sidecar_jsonb', async () => {
    const fs = buildFs({ extensible: true, extStrategy: 'sidecar_jsonb' });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const productsTable = phys.tables.find((t) => t.name === 'products_base');
    expect(productsTable?.strategy).toBe('sidecar_jsonb');
  });

  it('extensible not set → strategy is none (no ext table generated)', async () => {
    const fs = buildFs({ extensible: false });
    const { ir } = await load({ fs, basePath: '' });
    const phys = expandTables(ir);
    const productsTable = phys.tables.find((t) => t.name === 'products_base');
    expect(productsTable?.strategy).toBe('none');
    expect(productsTable?.extTableName).toBeUndefined();
  });
});
