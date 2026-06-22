import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldsCommand } from '../src/commands/fields.js';

const exampleRoot = resolve(__dirname, '../../../examples/product');

// Capture stdout while the command runs (it writes to process.stdout directly).
function captureStdout(fn: () => Promise<number>): { code: number; output: string } {
  const chunks: Buffer[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else chunks.push(chunk as Buffer);
    return true;
  }) as typeof process.stdout.write;
  let code = -1;
  return fn()
    .then((c) => {
      code = c;
      return { code, output: Buffer.concat(chunks).toString('utf-8') };
    })
    .finally(() => {
      process.stdout.write = orig;
    });
}

describe('loom fields command', () => {
  it('shows base fields + ext groups for a valid entity', async () => {
    const { code, output } = await captureStdout(() =>
      fieldsCommand({ path: exampleRoot, entity: 'entity:shop.core.Product' }),
    );
    expect(code).toBe(0);
    // Entity + table header
    expect(output).toContain('entity: shop.core.Product');
    expect(output).toContain('table: products_base');
    // Base fields
    expect(output).toContain('base fields');
    expect(output).toContain('id');
    expect(output).toContain('base_price_amount');
    // Extension groups
    expect(output).toContain('group: inventory');
    expect(output).toContain('sku');
    expect(output).toContain('group: pricing');
    expect(output).toContain('tier_price_amount');
    expect(output).toContain('group: logistics');
    expect(output).toContain('shipping_weight');
  });

  it('returns 64 for a non-existent entity', async () => {
    const { code } = await captureStdout(() =>
      fieldsCommand({ path: exampleRoot, entity: 'entity:shop.core.Nope' }),
    );
    expect(code).toBe(64);
  });
});
