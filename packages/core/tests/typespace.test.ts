import { describe, expect, it } from 'vitest';
import { parseTypeRef } from '../src/ir/typespace.js';

describe('parseTypeRef', () => {
  it('parses a three-segment type ref', () => {
    expect(parseTypeRef('base.core.Email')).toEqual({
      system: 'base',
      module: 'core',
      name: 'Email',
    });
  });

  it('returns null for a single-segment name (base_types short name)', () => {
    expect(parseTypeRef('integer')).toBeNull();
  });

  it('returns null for a two-segment name (invalid form)', () => {
    expect(parseTypeRef('base.Email')).toBeNull();
  });

  it('returns null for a four-segment name (invalid form)', () => {
    expect(parseTypeRef('a.b.c.d')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTypeRef('')).toBeNull();
  });

  it('returns null for a name with empty segments', () => {
    expect(parseTypeRef('base..Email')).toBeNull();
    expect(parseTypeRef('.core.Email')).toBeNull();
    expect(parseTypeRef('base.core.')).toBeNull();
  });
});
