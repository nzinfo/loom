/**
 * `loom project sql` — project schema to SQL DDL.
 * `loom project model` — output physical model as JSON.
 */
import { createWriteStream } from 'node:fs';
import process from 'node:process';
import type { Writable } from 'node:stream';
import { expandTables, load, projectSqlFromIr } from '@loom/core';
import type { Dialect } from '@loom/core';
import { NodeFileSystem } from '../shared/fs.js';
import { writeError } from '../shared/output.js';
import { projectModelJson } from './project_model.js';

const DIALECTS: readonly Dialect[] = ['pg', 'mysql', 'sqlite'];

export interface ProjectSqlOptions {
  readonly path: string;
  readonly dialect: string | undefined;
  readonly out: string | undefined;
  readonly physicalSchemas: readonly string[];
}

export async function projectSqlCommand(opts: ProjectSqlOptions): Promise<number> {
  if (opts.dialect === undefined || !DIALECTS.includes(opts.dialect as Dialect)) {
    writeError(`--dialect must be one of ${DIALECTS.join(', ')}`);
    return 64;
  }
  const dialect = opts.dialect as Dialect;

  const physicalSchemaOverrides = parsePhysicalSchemas(opts.physicalSchemas);
  if (physicalSchemaOverrides === null) return 64;

  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });
  if (result.diagnostics.hasErrors) {
    process.stderr.write(result.diagnostics.format());
    process.stderr.write('\n');
    return 1;
  }

  const projectOpts = physicalSchemaOverrides.size > 0 ? { physicalSchemaOverrides } : undefined;
  const sql = projectSqlFromIr(result.ir, dialect, projectOpts);

  const sink: Writable = opts.out ? createWriteStream(opts.out) : process.stdout;
  await new Promise<void>((resolve, reject) => {
    sink.write(sql, (err) => (err ? reject(err) : resolve()));
  });
  if (opts.out) sink.end();
  return 0;
}

export interface ProjectModelOptions {
  readonly path: string;
  readonly dialect: string | undefined;
  readonly physicalSchemas: readonly string[];
}

export async function projectModelCommand(opts: ProjectModelOptions): Promise<number> {
  const dialect = (opts.dialect ?? 'pg') as Dialect;
  if (!DIALECTS.includes(dialect)) {
    writeError(`--dialect must be one of ${DIALECTS.join(', ')}`);
    return 64;
  }

  const physicalSchemaOverrides = parsePhysicalSchemas(opts.physicalSchemas);
  if (physicalSchemaOverrides === null) return 64;

  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });
  if (result.diagnostics.hasErrors) {
    process.stderr.write(result.diagnostics.format());
    process.stderr.write('\n');
    return 1;
  }

  const projectOpts = physicalSchemaOverrides.size > 0 ? physicalSchemaOverrides : undefined;
  const model = expandTables(
    result.ir,
    physicalSchemaOverrides.size > 0 ? physicalSchemaOverrides : undefined,
  );
  const json = projectModelJson(result.ir, model, dialect);
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  return 0;
}

function parsePhysicalSchemas(specs: readonly string[]): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    if (eq <= 0) {
      writeError(`--physical-schema expects "<module.fqn>=<name>", got "${spec}"`);
      return null;
    }
    map.set(spec.slice(0, eq), spec.slice(eq + 1));
  }
  return map;
}
