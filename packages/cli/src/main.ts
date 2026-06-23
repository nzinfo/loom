#!/usr/bin/env node
/**
 * loom CLI entry point.
 *
 * Commands are organized as namespaces:
 *   loom version
 *   loom check <path>
 *   loom list <types|tables|entities|extensions> <path>
 *   loom show <type|table|entity|graph> <path> [<name>]
 *   loom project <sql|model> <path> [options]
 *
 * Exit codes: 0 success, 1 load/validation failure, 2 projection failure, 64 usage error.
 */
import process from 'node:process';
import { checkCommand } from './commands/check.js';
import { listCommand } from './commands/list.js';
import { projectModelCommand, projectSqlCommand } from './commands/project.js';
import {
  showEntityCommand,
  showGraphCommand,
  showTableCommand,
  showTypeCommand,
} from './commands/show.js';
import { versionCommand } from './commands/version.js';
import { parseFlag, parseFlagAll, parseGlobalFlags } from './shared/flags.js';
import { writeError } from './shared/output.js';

function usage(): void {
  process.stderr.write(`usage: loom <command> [options]

commands:
  version                                          print version info
  check [--json] <path>                            load + validate
  list <types|tables|entities|extensions> [--json] <path>
  show <type|table> <path> <identity> [--json]      node details
  show entity <path> <identity> [--json]            entity fields (base + ext groups)
  show graph <path> [--json]                        dependency graph
  project sql --dialect <d> [--out <f>] [--physical-schema <m>=<n>]... <path>
  project model [--dialect <d>] [--json] <path>
`);
}

async function main(argv: string[]): Promise<number> {
  const [, , cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage();
    return cmd === undefined ? 64 : 0;
  }

  switch (cmd) {
    case 'version':
      versionCommand();
      return 0;

    case 'check': {
      const { flags, remaining } = parseGlobalFlags(rest);
      const path = remaining[0];
      if (path === undefined) {
        writeError('check requires a path');
        return 64;
      }
      return await checkCommand({ path, flags });
    }

    case 'list': {
      const { flags, remaining } = parseGlobalFlags(rest);
      const kind = remaining[0];
      const path = remaining[1];
      if (path === undefined) {
        writeError('list requires a kind (types|tables|entities|extensions) and a path');
        return 64;
      }
      if (!['types', 'tables', 'entities', 'extensions'].includes(kind)) {
        writeError(`list kind must be types|tables|entities|extensions, got "${kind}"`);
        return 64;
      }
      return await listCommand(kind as 'types' | 'tables' | 'entities' | 'extensions', {
        path,
        flags,
      });
    }

    case 'show': {
      const { flags, remaining } = parseGlobalFlags(rest);
      const kind = remaining[0];
      const path = remaining[1];
      const name = remaining[2];

      if (path === undefined) {
        writeError('show requires a kind and path');
        return 64;
      }

      switch (kind) {
        case 'entity':
          if (name === undefined) {
            writeError('show entity requires an identity (e.g. entity:shop.core.Product)');
            return 64;
          }
          return await showEntityCommand({ path, entity: name, flags });
        case 'type':
          if (name === undefined) {
            writeError('show type requires an identity (e.g. type:shop.core.Money)');
            return 64;
          }
          return await showTypeCommand({ path, identity: name, flags });
        case 'table':
          if (name === undefined) {
            writeError('show table requires an identity (e.g. table:shop.core.Products)');
            return 64;
          }
          return await showTableCommand({ path, identity: name, flags });
        case 'graph':
          return await showGraphCommand({ path, flags });
        default:
          writeError(`show kind must be type|table|entity|graph, got "${kind}"`);
          return 64;
      }
    }

    case 'project': {
      const sub = rest[0];
      if (sub !== 'sql' && sub !== 'model') {
        writeError(`project target must be sql|model, got "${sub ?? ''}"`);
        return 64;
      }
      const tail = rest.slice(1);
      const { flags, remaining } = parseGlobalFlags(tail);
      const dialect = parseFlag(remaining, '--dialect').value;
      const physicalSchemas = parseFlagAll(remaining, '--physical-schema').values;
      const { remaining: r2 } = parseFlag(
        parseFlag(remaining, '--dialect').remaining,
        '--physical-schema',
      );
      const out = parseFlag(r2, '--out').value;
      const { remaining: r3 } = parseFlag(parseFlag(r2, '--out').remaining, '--physical-schema');
      const path = r3[0];

      if (path === undefined) {
        writeError('project requires a path');
        return 64;
      }

      if (sub === 'sql') {
        return await projectSqlCommand({ path, dialect, out, physicalSchemas });
      }
      return await projectModelCommand({ path, dialect, physicalSchemas });
    }

    default:
      writeError(`unknown command "${cmd}"`);
      usage();
      return 64;
  }
}

const code = await main(process.argv);
process.exit(code);
