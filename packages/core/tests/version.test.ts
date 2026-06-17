import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, FILE_KIND, FORMAT_FAMILY, FORMAT_VERSION } from '../src/index.js';

describe('format version', () => {
  it('exposes the expected family and version', () => {
    expect(FORMAT_FAMILY).toBe('loom-schema');
    expect(FORMAT_VERSION).toBe('v2');
    expect(CURRENT_VERSION).toBe('loom-schema/v2');
  });

  it('covers every file kind from spec §9', () => {
    expect(FILE_KIND).toEqual([
      'base_types',
      'module_manifest',
      'value_type',
      'mixin',
      'table',
      'entity',
      'extension_fields',
    ]);
  });
});
