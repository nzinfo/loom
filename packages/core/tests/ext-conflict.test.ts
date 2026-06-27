/**
 * Tests for multi-owner extension conflict detection enhancements:
 * - Same owner + same entity + same group name across files → error
 * - Struct-expansion key collision (two fields produce same JSON key) → error
 */
import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/errors.js';
import type { AnyFile } from '../src/ir/schemas.js';
import type { DiscoveredEntry } from '../src/loader/discovery.js';
import { link } from '../src/loader/link.js';
import type { ParsedExtensionFields } from '../src/loader/parse.js';
import { validate } from '../src/loader/validate.js';

function makeExtFile(
  path: string,
  entity: string,
  fields: Array<{ name: string; type: string }>,
  group?: string,
): { identity: string; file: AnyFile } {
  const data = {
    version: 'loom-schema/v2',
    entity,
    ...(group ? { group } : {}),
    fields,
  };
  return {
    identity: path,
    file: {
      kind: 'extension_fields' as const,
      raw: data,
      file: path,
      line: 1,
      column: 1,
      data,
    },
  };
}

function makeDiscoveredEntry(path: string, ownerKind: string): [string, DiscoveredEntry] {
  const owner =
    ownerKind === 'platform'
      ? { kind: 'platform' as const }
      : ownerKind.startsWith('ext:')
        ? { kind: 'ext' as const, provider: ownerKind.slice(4) }
        : { kind: 'tenant' as const, id: ownerKind.slice(7) };
  return [
    path,
    {
      identity: path,
      path,
      meta: { identity: path, owner, kind: 'extension_fields', system: '', module: '' },
    },
  ];
}

describe('extension conflict: duplicate group from same owner', () => {
  it('reports error when same owner declares same group twice on same entity', async () => {
    const diag = new Diagnostics();
    const extFiles: ParsedExtensionFields[] = [
      makeExtFile(
        'platform/base/core/user_a.ext.yaml',
        'entity:base.core.User',
        [{ name: 'nickname', type: 'string' }],
        'profile',
      ),
      makeExtFile(
        'platform/base/core/user_b.ext.yaml',
        'entity:base.core.User',
        [{ name: 'bio', type: 'string' }],
        'profile', // same group, same owner (platform), different file
      ),
    ];
    const files = new Map<string, DiscoveredEntry>([
      makeDiscoveredEntry('platform/base/core/user_a.ext.yaml', 'platform'),
      makeDiscoveredEntry('platform/base/core/user_b.ext.yaml', 'platform'),
    ]);

    await link({
      parsed: new Map(),
      extensionFieldsFiles: extFiles,
      files,
      diagnostics: diag,
    });

    const messages = [...diag.errors].map((e) => e.message);
    expect(
      messages.some((m) => m.includes('duplicate group "profile"') && m.includes('platform')),
    ).toBe(true);
  });

  it('allows different owners to use the same group name', async () => {
    const diag = new Diagnostics();
    const extFiles: ParsedExtensionFields[] = [
      makeExtFile(
        'platform/base/core/user_profile.ext.yaml',
        'entity:base.core.User',
        [{ name: 'nickname', type: 'string' }],
        'profile',
      ),
      makeExtFile(
        'tenants/acme/base/core/user_fields.ext.yaml',
        'entity:base.core.User',
        [{ name: 'customer_no', type: 'string' }],
        'profile', // same group, but different owner (tenant:acme) — OK
      ),
    ];
    const files = new Map<string, DiscoveredEntry>([
      makeDiscoveredEntry('platform/base/core/user_profile.ext.yaml', 'platform'),
      makeDiscoveredEntry('tenants/acme/base/core/user_fields.ext.yaml', 'tenant:acme'),
    ]);

    await link({
      parsed: new Map(),
      extensionFieldsFiles: extFiles,
      files,
      diagnostics: diag,
    });

    const messages = [...diag.errors].map((e) => e.message);
    expect(messages.some((m) => m.includes('duplicate group'))).toBe(false);
  });
});

describe('extension conflict: struct-expansion key collision', () => {
  it('reports error when two fields expand to the same JSON key', async () => {
    // Setup: a Money struct with amount + currency_code
    const moneyType: AnyFile = {
      kind: 'type',
      raw: {},
      file: 'platform/base/core/money.type.yaml',
      line: 1,
      column: 1,
      data: {
        version: 'loom-schema/v2',
        name: 'Money',
        form: 'struct',
        fields: [
          { name: 'amount', type: { ref: 'decimal', args: { precision: 18, scale: 4 } } },
          { name: 'currency_code', type: { ref: 'string', args: { max_length: 3 } } },
        ],
      },
    };

    const diag = new Diagnostics();

    // Link pass to aggregate extension fields
    const extFiles: ParsedExtensionFields[] = [
      makeExtFile('platform/base/core/user.ext.yaml', 'entity:base.core.User', [
        { name: 'balance', type: 'base.core.Money' }, // → balance_amount, balance_currency_code
        { name: 'balance_amount', type: 'string' }, // ← collides with balance_amount!
      ]),
    ];

    const parsed = new Map<string, AnyFile>([['type:base.core.Money', moneyType]]);
    const files = new Map<string, DiscoveredEntry>([
      makeDiscoveredEntry('platform/base/core/user.ext.yaml', 'platform'),
    ]);

    const linkResult = await link({
      parsed,
      extensionFieldsFiles: extFiles,
      files,
      diagnostics: diag,
    });

    // Validate pass — should detect the collision
    validate({ ir: linkResult.ir, diagnostics: diag });

    const messages = [...diag.errors].map((e) => e.message);
    expect(messages.some((m) => m.includes('key collision') && m.includes('balance_amount'))).toBe(
      true,
    );
  });

  it('does not report collision when keys are distinct', async () => {
    const moneyType: AnyFile = {
      kind: 'type',
      raw: {},
      file: 'platform/base/core/money.type.yaml',
      line: 1,
      column: 1,
      data: {
        version: 'loom-schema/v2',
        name: 'Money',
        form: 'struct',
        fields: [
          { name: 'amount', type: { ref: 'decimal', args: { precision: 18, scale: 4 } } },
          { name: 'currency_code', type: { ref: 'string', args: { max_length: 3 } } },
        ],
      },
    };

    const diag = new Diagnostics();

    const extFiles: ParsedExtensionFields[] = [
      makeExtFile('platform/base/core/user.ext.yaml', 'entity:base.core.User', [
        { name: 'balance', type: 'base.core.Money' }, // → balance_amount, balance_currency_code
        { name: 'nickname', type: 'string' }, // no collision
      ]),
    ];

    const parsed = new Map<string, AnyFile>([['type:base.core.Money', moneyType]]);
    const files = new Map<string, DiscoveredEntry>([
      makeDiscoveredEntry('platform/base/core/user.ext.yaml', 'platform'),
    ]);

    const linkResult = await link({
      parsed,
      extensionFieldsFiles: extFiles,
      files,
      diagnostics: diag,
    });

    validate({ ir: linkResult.ir, diagnostics: diag });

    const messages = [...diag.errors].map((e) => e.message);
    expect(messages.some((m) => m.includes('key collision'))).toBe(false);
  });
});
