import { describe, expect, it } from 'vitest';
import {
  enumHasMetadata,
  escapeSqlSingleQuote,
  formatEnumComment,
  formatEnumCommentBody,
} from '../src/projector/enumMeta.js';

describe('enumMeta', () => {
  describe('enumHasMetadata', () => {
    it('returns false for bare-value variants only', () => {
      expect(enumHasMetadata([{ value: 'a' }, { value: 'b' }])).toBe(false);
    });

    it('returns true when any variant has display_name', () => {
      expect(enumHasMetadata([{ value: 'a' }, { value: 'b', display_name: 'B' }])).toBe(true);
    });

    it('returns true when any variant has description', () => {
      expect(enumHasMetadata([{ value: 'a', description: 'the a' }, { value: 'b' }])).toBe(true);
    });
  });

  describe('formatEnumCommentBody', () => {
    it('returns undefined when no variant carries metadata', () => {
      expect(formatEnumCommentBody([{ value: 'active' }, { value: 'inactive' }])).toBeUndefined();
    });

    it('formats value=display_name for labeled variants', () => {
      expect(
        formatEnumCommentBody([{ value: 'active', display_name: 'Active' }, { value: 'inactive' }]),
      ).toBe('active=Active|inactive');
    });

    it('formats value=display_name;description when both present', () => {
      expect(
        formatEnumCommentBody([
          { value: 'active', display_name: 'Active' },
          { value: 'suspended', display_name: 'Suspended', description: 'frozen' },
          { value: 'plain' },
        ]),
      ).toBe('active=Active|suspended=Suspended;frozen|plain');
    });

    it('formats value=;description when only description present', () => {
      expect(formatEnumCommentBody([{ value: 'a', description: 'the a' }])).toBe('a=;the a');
    });

    it('returns undefined when display_name contains a forbidden delimiter (|)', () => {
      // | would break entry separation → refuse to emit (avoid malformed comment)
      expect(formatEnumCommentBody([{ value: 'a', display_name: 'x|y' }])).toBeUndefined();
    });

    it('returns undefined when description contains a forbidden delimiter (;)', () => {
      expect(formatEnumCommentBody([{ value: 'a', description: 'x;y' }])).toBeUndefined();
    });

    it('returns undefined when display_name contains "="', () => {
      expect(formatEnumCommentBody([{ value: 'a', display_name: 'x=y' }])).toBeUndefined();
    });

    it('returns undefined when description contains a newline', () => {
      expect(formatEnumCommentBody([{ value: 'a', description: 'line1\nline2' }])).toBeUndefined();
    });

    it('returns undefined when display_name contains a single quote', () => {
      expect(formatEnumCommentBody([{ value: 'a', display_name: "it's" }])).toBeUndefined();
    });

    it('still emits if only ONE of several variants has a forbidden char (whole enum refused)', () => {
      // Conservative: one bad value → no comment at all, not partial.
      expect(
        formatEnumCommentBody([
          { value: 'a', display_name: 'A' },
          { value: 'b', display_name: 'x|y' },
        ]),
      ).toBeUndefined();
    });
  });

  describe('formatEnumComment', () => {
    it('prefixes the body with the loom:enum marker', () => {
      expect(formatEnumComment([{ value: 'a', display_name: 'A' }])).toBe('loom:enum a=A');
    });

    it('returns undefined when there is no metadata', () => {
      expect(formatEnumComment([{ value: 'a' }])).toBeUndefined();
    });
  });

  describe('escapeSqlSingleQuote', () => {
    it('doubles single quotes (PG/MySQL string literal escaping)', () => {
      expect(escapeSqlSingleQuote("it's")).toBe("it''s");
    });

    it('leaves strings without quotes unchanged', () => {
      expect(escapeSqlSingleQuote('plain')).toBe('plain');
    });

    it('escapes multiple quotes', () => {
      expect(escapeSqlSingleQuote("'a'b'")).toBe("''a''b''");
    });
  });
});
