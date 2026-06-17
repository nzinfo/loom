import { describe, expect, it } from 'vitest';
import { projectCommand } from '../src/commands/project.js';

describe('loom project sql', () => {
  it('returns usage error when dialect missing', async () => {
    const code = await projectCommand({ path: '/tmp/whatever', dialect: undefined, out: undefined });
    expect(code).toBe(64);
  });

  it('returns usage error for unknown dialect', async () => {
    const code = await projectCommand({ path: '/tmp/whatever', dialect: 'oracle', out: undefined });
    expect(code).toBe(64);
  });
});
