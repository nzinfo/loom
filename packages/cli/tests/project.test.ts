import { describe, expect, it } from 'vitest';
import { projectSqlCommand } from '../src/commands/project.js';

describe('loom project sql', () => {
  it('returns usage error when dialect missing', async () => {
    const code = await projectSqlCommand({
      path: '/tmp/whatever',
      dialect: undefined,
      out: undefined,
      physicalSchemas: [],
    });
    expect(code).toBe(64);
  });

  it('returns usage error for unknown dialect', async () => {
    const code = await projectSqlCommand({
      path: '/tmp/whatever',
      dialect: 'oracle',
      out: undefined,
      physicalSchemas: [],
    });
    expect(code).toBe(64);
  });
});
