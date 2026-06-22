#!/usr/bin/env node
/**
 * loom CLI entry point.
 *
 * Exit codes (spec §16.1):
 *   0  success
 *   1  load / validation failure
 *   2  projection failure
 *   64 usage error
 */
import process from 'node:process';
import { checkCommand } from './commands/check.js';
import { fieldsCommand } from './commands/fields.js';
import { projectCommand } from './commands/project.js';
import { versionCommand } from './commands/version.js';

function usage(): void {
  process.stderr.write(`usage: loom <command> [options]

commands:
  version                                  print version info (spec §16.2)
  check <path>                             load + validate (spec §8.7)
  fields <path> <entity>                   inspect an entity's fields (base + ext groups)
  project sql --dialect <d> [--out <f>] [--physical-schema <mod>=<name>]... <path>   project to SQL DDL (spec §8.8)
  fmt <path>                               reformat in place (not yet implemented)
  lift <physical.yaml>                     reverse-lift (not yet implemented)
`);
}

function parseFlag(
  rest: readonly string[],
  name: string,
): { value: string | undefined; remaining: string[] } {
  const idx = rest.indexOf(name);
  if (idx < 0) return { value: undefined, remaining: [...rest] };
  const value = rest[idx + 1];
  const remaining = [...rest.slice(0, idx), ...rest.slice(idx + 2)];
  return { value, remaining };
}

/** Parse all occurrences of a repeatable flag (e.g. --physical-schema a=x --physical-schema b=y). */
function parseFlagAll(
  rest: readonly string[],
  name: string,
): { values: string[]; remaining: string[] } {
  const values: string[] = [];
  let remaining = [...rest];
  for (;;) {
    const r = parseFlag(remaining, name);
    if (r.value === undefined) break;
    values.push(r.value);
    remaining = r.remaining;
  }
  return { values, remaining };
}

async function main(argv: string[]): Promise<number> {
  const [, , cmd, ...rest] = argv;

  switch (cmd) {
    case 'version':
      versionCommand();
      return 0;
    case 'check': {
      const path = rest[0];
      if (path === undefined) {
        process.stderr.write('error: check requires a path\n');
        return 64;
      }
      return await checkCommand({ path });
    }
    case 'fields': {
      const path = rest[0];
      const entity = rest[1];
      if (path === undefined) {
        process.stderr.write('error: fields requires a path and entity identity\n');
        return 64;
      }
      if (entity === undefined) {
        process.stderr.write(
          'error: fields requires an entity identity (e.g. entity:shop.core.Product)\n',
        );
        return 64;
      }
      return await fieldsCommand({ path, entity });
    }
    case 'project': {
      const sub = rest[0];
      if (sub !== 'sql') {
        process.stderr.write(`error: unknown project target "${sub ?? ''}"\n`);
        return 64;
      }
      const tail = rest.slice(1);
      const dialect = parseFlag(tail, '--dialect').value;
      const out = parseFlag(tail, '--out').value;
      const physicalSchemas = parseFlagAll(tail, '--physical-schema').values;
      const { remaining } = parseFlag(parseFlag(tail, '--dialect').remaining, '--out');
      const path = remaining[0];
      if (path === undefined) {
        process.stderr.write('error: project requires a path\n');
        return 64;
      }
      return await projectCommand({ path, dialect, out, physicalSchemas });
    }
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage();
      return 64;
    default:
      process.stderr.write(`error: unknown command "${cmd}"\n\n`);
      usage();
      return 64;
  }
}

const code = await main(process.argv);
process.exit(code);
