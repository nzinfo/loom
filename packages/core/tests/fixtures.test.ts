import { describe, expect, it } from 'vitest';
import { buildBaseSchemaFs } from './fixtures/base_schema.js';

describe('base schema fixture', () => {
  it('can be constructed', () => {
    const fs = buildBaseSchemaFs();
    expect(fs).toBeDefined();
  });
});
