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

  it('returns null for a single-segment name (scalar short name — not a type ref)', () => {
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
  // Unified candidate set: ALL type fqns (scalar + struct + enum). Scalars
  // are first-class types — they resolve through using just like struct/enum.
  // base.core's types are globally available because base.core.* is injected
  // by the caller as a default, not because scalars are special.
  const typeFqns = new Set([
    'base.core.integer',
    'base.core.string',
    'base.core.decimal',
    'base.core.datetime',
    'base.core.boolean',
    'base.core.Email',
    'base.core.Money',
    'retail.pos.types.Money',
  ]);

  it('resolves a scalar short name via the default base.core.* namespace', () => {
    const result = resolveShortName('integer', ['base.core.*'], typeFqns);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.fqn).toBe('base.core.integer');
    }
  });

  it('resolves a struct short name via module wildcard using', () => {
    const result = resolveShortName('Email', ['base.core.*'], typeFqns);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.fqn).toBe('base.core.Email');
    }
  });

  it('resolves a type short name via precise using', () => {
    const result = resolveShortName('Email', ['base.core.Email'], typeFqns);
    expect(result.kind === 'resolved' && result.fqn).toBe('base.core.Email');
  });

  it('reports ambiguous when two wildcards both match', () => {
    const result = resolveShortName('Money', ['base.core.*', 'retail.pos.types.*'], typeFqns);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toEqual(
        expect.arrayContaining(['base.core.Money', 'retail.pos.types.Money']),
      );
    }
  });

  it('reports unknown when nothing matches', () => {
    const result = resolveShortName('Nonexistent', ['base.core.*'], typeFqns);
    expect(result.kind).toBe('unknown');
  });

  it('precise using + wildcard resolve to one fqn (no ambiguity — same target)', () => {
    // base.core.* and base.core.Money both point at base.core.Money — a single
    // distinct fqn, not ambiguous.
    const result = resolveShortName('Money', ['base.core.*', 'base.core.Money'], typeFqns);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.fqn).toBe('base.core.Money');
    }
  });

  it('scalar and struct with the same declared name resolve identically (no precedence)', () => {
    // Unified resolution: there is no "scalar precedence". If a short name
    // resolves to exactly one fqn, it resolves — regardless of form.
    const result = resolveShortName('Money', ['base.core.*'], typeFqns);
    expect(result.kind).toBe('resolved');
  });

  it('resolves a renamed import (form C: "ns.Name as Alias")', () => {
    // base.core.Money as Cash → short name "Cash" resolves to base.core.Money
    const result = resolveShortName('Cash', ['base.core.Money as Cash', 'base.core.*'], typeFqns);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.fqn).toBe('base.core.Money');
    }
  });

  it('rename disambiguates two same-name types from different namespaces', () => {
    // Two namespaces both have Money; import one with an alias
    const fqns = new Set([...typeFqns, 'shop.billing.Money']);
    // Without rename: ambiguous
    const ambiguous = resolveShortName('Money', ['base.core.*', 'shop.billing.*'], fqns);
    expect(ambiguous.kind).toBe('ambiguous');
    // With rename: resolves to the aliased one
    const resolved = resolveShortName(
      'BillingMoney',
      ['shop.billing.Money as BillingMoney', 'base.core.*'],
      fqns,
    );
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind === 'resolved') {
      expect(resolved.fqn).toBe('shop.billing.Money');
    }
  });
});
