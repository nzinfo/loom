import { describe, expect, it } from 'vitest';
import { type ResolutionResult, parseTypeRef, resolveShortName } from '../src/ir/typespace.js';

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

describe('resolveShortName', () => {
  // Candidate set: base_types scalars (single-segment names) + value_type
  // fully-qualified names. Provided by the caller (link pass).
  const scalars = new Set(['integer', 'string', 'decimal', 'datetime', 'boolean', 'enum']);
  const valueTypes = new Set(['base.core.Email', 'base.core.Money', 'retail.pos.types.Money']);

  it('resolves a base_types scalar short name regardless of using', () => {
    const result = resolveShortName('integer', [], scalars, valueTypes);
    expect(result.kind).toBe('scalar');
    if (result.kind === 'scalar') {
      expect(result.name).toBe('integer');
    }
  });

  it('resolves a value_type short name via module wildcard using', () => {
    const result = resolveShortName('Email', ['base.core.*'], scalars, valueTypes);
    expect(result.kind).toBe('value_type');
    if (result.kind === 'value_type') {
      expect(result.fqn).toBe('base.core.Email');
    }
  });

  it('resolves a value_type short name via precise using', () => {
    const result = resolveShortName('Email', ['base.core.Email'], scalars, valueTypes);
    expect(result.kind === 'value_type' && result.fqn).toBe('base.core.Email');
    if (result.kind === 'value_type') {
      expect(result.fqn).toBe('base.core.Email');
    }
  });

  it('reports ambiguous when two wildcards both match', () => {
    const result = resolveShortName(
      'Money',
      ['base.core.*', 'retail.pos.types.*'],
      scalars,
      valueTypes,
    );
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toEqual(
        expect.arrayContaining(['base.core.Money', 'retail.pos.types.Money']),
      );
    }
  });

  it('reports unknown when nothing matches', () => {
    const result = resolveShortName('Nonexistent', ['base.core.*'], scalars, valueTypes);
    expect(result.kind).toBe('unknown');
  });

  it('precise using wins over wildcard (no ambiguity)', () => {
    // Even though base.core.* would also match, an explicit precise import
    // pins the name unambiguously.
    const result = resolveShortName(
      'Money',
      ['base.core.*', 'base.core.Money'],
      scalars,
      valueTypes,
    );
    expect(result.kind).toBe('value_type');
    if (result.kind === 'value_type') {
      expect(result.fqn).toBe('base.core.Money');
    }
  });

  it('scalar lookup takes precedence over value_type using', () => {
    // If a short name collides between a scalar and a value_type via using,
    // the scalar (default namespace) wins — that matches "base_types always
    // available" semantics.
    const scalarsWithConflict = new Set(['Money']);
    const result = resolveShortName('Money', ['base.core.*'], scalarsWithConflict, valueTypes);
    expect(result.kind).toBe('scalar');
  });
});
