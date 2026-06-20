import { describe, expect, it } from 'vitest';
import { type Ref, formatRef, parseRef } from '../src/ir/refs.js';

describe('refs', () => {
  it('parses a fully-qualified ref', () => {
    expect(parseRef('type:base.core.Email')).toEqual({
      kind: 'type',
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
    expect(() => parseRef('type:base')).toThrow(/invalid \$ref/);
    expect(() => parseRef('type:base.core')).toThrow(/invalid \$ref/);
  });

  it('parses short-form refs (no system.module)', () => {
    expect(parseRef('type:.Money')).toEqual({
      kind: 'type',
      system: '',
      module: '',
      name: 'Money',
    });
  });

  it('round-trips formatRef ∘ parseRef for both forms', () => {
    const fq = 'type:base.core.Email';
    expect(formatRef(parseRef(fq))).toBe(fq);
    const short = 'type:.Money';
    expect(formatRef(parseRef(short))).toBe(short);
  });
});
