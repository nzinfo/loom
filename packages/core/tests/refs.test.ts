import { describe, expect, it } from 'vitest';
import { type Ref, formatRef, parseRef } from '../src/ir/refs.js';

describe('refs', () => {
  it('parses a fully-qualified ref', () => {
    expect(parseRef('value_type:base.core.Email')).toEqual({
      kind: 'value_type',
      system: 'base',
      module: 'core',
      name: 'Email',
    } satisfies Ref);
  });

  it('formats a ref back to its canonical string', () => {
    const ref: Ref = { kind: 'entity', system: 'retail', module: 'pos', name: 'Order' };
    expect(formatRef(ref)).toBe('entity:retail.pos.Order');
  });

  it('rejects malformed refs', () => {
    expect(() => parseRef('not-a-ref')).toThrow(/invalid \$ref/);
    expect(() => parseRef('value_type:base')).toThrow(/invalid \$ref/);
    expect(() => parseRef('value_type:base.core')).toThrow(/invalid \$ref/);
  });

  it('parses short-form refs (no system.module)', () => {
    expect(parseRef('value_type:.Money')).toEqual({
      kind: 'value_type',
      system: '',
      module: '',
      name: 'Money',
    });
  });
});
