import { describe, expect, it } from 'vitest';
import { type ValueTypeNode, expandValueColumns, isSingleFieldValueType } from '../src/ir/field.js';

describe('field expansion', () => {
  const email: ValueTypeNode = {
    kind: 'value_type',
    name: 'Email',
    fields: [{ name: 'value', base: 'string', max_length: 254 }],
  };

  const money: ValueTypeNode = {
    kind: 'value_type',
    name: 'Money',
    fields: [
      { name: 'amount', base: 'decimal', precision: 18, scale: 4 },
      { name: 'currency_code', base: 'string', max_length: 3 },
    ],
  };

  it('a single-field value_type with name "value" is single', () => {
    expect(isSingleFieldValueType(email)).toBe(true);
  });

  it('a multi-field value_type is not single', () => {
    expect(isSingleFieldValueType(money)).toBe(false);
  });

  it('expands a single-field ref as one column with no suffix', () => {
    const cols = expandValueColumns('email', email);
    expect(cols).toEqual([{ name: 'email' }]);
  });

  it('expands a multi-field ref as prefix_fieldname columns', () => {
    const cols = expandValueColumns('balance', money);
    expect(cols).toEqual([{ name: 'balance_amount' }, { name: 'balance_currency_code' }]);
  });

  it('rejects single-field value_type whose field name is not "value"', () => {
    const weird: ValueTypeNode = {
      kind: 'value_type',
      name: 'Weird',
      fields: [{ name: 'x', base: 'string' }],
    };
    // Not a single-field-newtype under spec §5.5; treat as multi-style.
    expect(isSingleFieldValueType(weird)).toBe(false);
    expect(expandValueColumns('weird', weird)).toEqual([{ name: 'weird_x' }]);
  });

  it('handles three-field value_type expansion', () => {
    const three: ValueTypeNode = {
      kind: 'value_type',
      name: 'DateRange',
      fields: [
        { name: 'start', base: 'date' },
        { name: 'end', base: 'date' },
        { name: 'tz', base: 'string' },
      ],
    };
    expect(expandValueColumns('period', three)).toEqual([
      { name: 'period_start' },
      { name: 'period_end' },
      { name: 'period_tz' },
    ]);
  });

  it('handles empty value_type fields defensively', () => {
    const empty: ValueTypeNode = {
      kind: 'value_type',
      name: 'Empty',
      fields: [],
    };
    expect(isSingleFieldValueType(empty)).toBe(false);
    expect(expandValueColumns('e', empty)).toEqual([]);
  });
});
