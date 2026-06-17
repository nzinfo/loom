#!/usr/bin/env node
/**
 * loom CLI entry point.
 *
 * Usage:
 *   loom version
 *   loom check <path>
 *   loom fmt <path>            (not yet implemented)
 *   loom project sql --dialect pg --out <dir> <path>   (not yet implemented)
 *   loom lift <physical.yaml> --out <dir>              (not yet implemented)
 *
 * Exit codes (spec §16.1):
 *   0  success
 *   1  load / validation failure
 *   2  projection failure
 *   64 usage error
 */
import process from 'node:process';
import { versionCommand } from './commands/version.js';
import { checkCommand } from './commands/check.js';

function usage(): void {
  process.stderr.write(`usage: loom <command> [options]

commands:
  version                    print version info (spec §16.2)
  check <path>               load + validate (spec §8.7)
  fmt <path>                 reformat in place (not yet implemented)
  project sql|atlas-yaml     project design schema to physical (not yet implemented)
  lift <physical.yaml>       reverse-lift to design schema draft (not yet implemented)
`);
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
