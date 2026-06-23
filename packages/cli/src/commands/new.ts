/**
 * `loom new <kind> <path> <identity> [options]`
 *
 * Creates a new schema node file. CLI handles correct file path, naming,
 * version header, and using declaration.
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pascalToKebab } from '@loom/core';
import { parseIdentity } from '../shared/identity.js';
import { writeError, writeText } from '../shared/output.js';
import { toYaml } from '../yaml/editor.js';

function parseFqn(identity: string): { system: string; module: string; name: string } | undefined {
  const parts = identity.split('.');
  if (parts.length < 3) return undefined;
  return { system: parts[0]!, module: parts[1]!, name: parts.slice(2).join('.') };
}

// ── new type ─────────────────────────────────────────────────

export interface NewTypeOptions {
  readonly path: string;
  readonly identity: string;
  readonly form: 'scalar' | 'struct' | 'enum';
}

export async function newTypeCommand(opts: NewTypeOptions): Promise<number> {
  const fqn = parseFqn(opts.identity);
  if (fqn === undefined) {
    writeError(`identity must be <system>.<module>.<Name>, got: ${opts.identity}`);
    return 64;
  }
  const dir = path.join(opts.path, 'platform', fqn.system, fqn.module);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${pascalToKebab(fqn.name)}.type.yaml`);
  await assertNotExists(filePath);

  let obj: Record<string, unknown>;
  switch (opts.form) {
    case 'scalar':
      obj = {
        version: 'loom-schema/v2',
        name: fqn.name.toLowerCase(),
        form: 'scalar',
        description: fqn.name.toLowerCase(),
        properties: [],
      };
      break;
    case 'struct':
      obj = {
        version: 'loom-schema/v2',
        name: fqn.name,
        form: 'struct',
        using: [`${fqn.system}.${fqn.module}.*`],
        fields: [{ name: 'value', type: 'string' }],
      };
      break;
    case 'enum':
      obj = {
        version: 'loom-schema/v2',
        name: fqn.name,
        form: 'enum',
        variants: [{ value: 'option_a' }, { value: 'option_b' }],
      };
      break;
  }

  await fs.writeFile(filePath, toYaml(obj), 'utf-8');
  writeText(`created: ${filePath}`);
  return 0;
}

// ── new table ────────────────────────────────────────────────

export interface NewTableOptions {
  readonly path: string;
  readonly identity: string;
}

export async function newTableCommand(opts: NewTableOptions): Promise<number> {
  const fqn = parseFqn(opts.identity);
  if (fqn === undefined) {
    writeError(`identity must be <system>.<module>.<Name>, got: ${opts.identity}`);
    return 64;
  }
  const dir = path.join(opts.path, 'platform', fqn.system, fqn.module);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${pascalToKebab(fqn.name)}.table.yaml`);
  await assertNotExists(filePath);

  const obj = {
    version: 'loom-schema/v2',
    name: fqn.name,
    table: {
      name: `${pascalToKebab(fqn.name)}_base`,
      extension: { strategy: 'none' },
    },
    using: [`${fqn.system}.${fqn.module}.*`],
    fields: [{ name: 'id', type: 'bigint', required: true }],
    primary_key: ['id'],
  };

  await fs.writeFile(filePath, toYaml(obj), 'utf-8');
  writeText(`created: ${filePath}`);
  return 0;
}

// ── new entity ───────────────────────────────────────────────

export interface NewEntityOptions {
  readonly path: string;
  readonly identity: string;
  readonly table: string;
}

export async function newEntityCommand(opts: NewEntityOptions): Promise<number> {
  const fqn = parseFqn(opts.identity);
  if (fqn === undefined) {
    writeError(`identity must be <system>.<module>.<Name>, got: ${opts.identity}`);
    return 64;
  }
  const dir = path.join(opts.path, 'platform', fqn.system, fqn.module);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${pascalToKebab(fqn.name)}.entity.yaml`);
  await assertNotExists(filePath);

  const obj = {
    version: 'loom-schema/v2',
    name: fqn.name,
    primary_table: opts.table,
  };

  await fs.writeFile(filePath, toYaml(obj), 'utf-8');
  writeText(`created: ${filePath}`);
  return 0;
}

// ── new extension ────────────────────────────────────────────

export interface NewExtensionOptions {
  readonly path: string;
  readonly entity: string;
  readonly group: string;
  readonly owner: string;
}

export async function newExtensionCommand(opts: NewExtensionOptions): Promise<number> {
  const entityParsed = parseIdentity(opts.entity);
  if (entityParsed?.kind !== 'entity') {
    writeError(`invalid entity identity: ${opts.entity}`);
    return 64;
  }
  const fqn = parseFqn(entityParsed.fqn);
  if (fqn === undefined) {
    writeError(`entity fqn must be <system>.<module>.<Name>, got: ${entityParsed.fqn}`);
    return 64;
  }

  const ownerDir = ownerToPrefix(opts.owner);
  const dir = path.join(opts.path, ownerDir, fqn.system, fqn.module);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${pascalToKebab(opts.group)}.ext.yaml`);
  await assertNotExists(filePath);

  const obj = {
    version: 'loom-schema/v2',
    entity: opts.entity,
    group: opts.group,
    using: [`${fqn.system}.${fqn.module}.*`],
    fields: [{ name: 'placeholder', type: 'string' }],
  };

  await fs.writeFile(filePath, toYaml(obj), 'utf-8');
  writeText(`created: ${filePath}`);
  return 0;
}

// ── helpers ──────────────────────────────────────────────────

function ownerToPrefix(owner: string): string {
  if (owner === 'platform') return 'platform';
  if (owner.startsWith('ext:')) return `ext/${owner.slice('ext:'.length)}`;
  if (owner.startsWith('tenant:')) return `tenants/${owner.slice('tenant:'.length)}`;
  return 'platform';
}

async function assertNotExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
    writeError(`file already exists: ${filePath}`);
    process.exit(3);
  } catch {
    // doesn't exist — good
  }
}
