import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../src/commands/version.js';

describe('cli smoke', () => {
  it('exposes a pinned CLI version', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
