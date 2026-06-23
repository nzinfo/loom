import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { showEntityCommand } from '../src/commands/show.js';

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
  return fn()
    .then((code) => ({
      code,
      output: Buffer.concat(chunks).toString('utf-8'),
    }))
    .finally(() => {
      process.stdout.write = orig;
    });
}

const jsonOff = { json: false, quiet: false };

describe('loom show entity', () => {
  it('shows base fields + ext groups for a valid entity', async () => {
    const { code, output } = await captureStdout(() =>
      showEntityCommand({
        path: exampleRoot,
        entity: 'entity:shop.core.Product',
        flags: jsonOff,
      }),
    );
    expect(code).toBe(0);
    expect(output).toContain('entity: shop.core.Product');
    expect(output).toContain('table: products_base');
    expect(output).toContain('base fields');
    expect(output).toContain('id');
    expect(output).toContain('base_price_amount');
    expect(output).toContain('group: inventory (ext:provider-a)');
    expect(output).toContain('sku');
    expect(output).toContain('group: pricing (ext:provider-b)');
    expect(output).toContain('tier_price_amount');
    expect(output).toContain('group: logistics (ext:provider-b)');
    expect(output).toContain('shipping_weight');
  });

  it('returns 64 for a non-existent entity', async () => {
    const { code } = await captureStdout(() =>
      showEntityCommand({
        path: exampleRoot,
        entity: 'entity:shop.core.Nope',
        flags: jsonOff,
      }),
    );
    expect(code).toBe(64);
  });
});
