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
import {
  addFieldCommand,
  moveFieldCommand,
  orderFieldsCommand,
  rmFieldCommand,
} from './commands/edit.js';
import { fmtCommand } from './commands/fmt.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import {
  newEntityCommand,
  newExtensionCommand,
  newTableCommand,
  newTypeCommand,
} from './commands/new.js';
import { projectModelCommand, projectSqlCommand } from './commands/project.js';
import { projectAtlasCommand } from './commands/project_atlas.js';
import { rmExtensionCommand, rmNodeCommand } from './commands/rm.js';
import {
  showEntityCommand,
  showGraphCommand,
  showTableCommand,
  showTypeCommand,
} from './commands/show.js';
import { updateTableCommand } from './commands/update.js';
import { versionCommand } from './commands/version.js';
import { extractFlags, parseFlag, parseFlagAll, parseGlobalFlags } from './shared/flags.js';
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
  project atlas-yaml [--dialect <d>] <path>
  init <path> --system <s> [--module core] [--no-example] [--force]
  new type <path> <sys.mod.Name> [--form scalar|struct|enum]
  new table <path> <sys.mod.Name>
  new entity <path> <sys.mod.Name> --table <table:...>
  new extension <path> --entity <entity:...> [--group <name>] [--owner <owner>]
  add field <path> <target> <name> <type> [--required] [--unique] [--column <c>] [--args k=v]...
  rm field <path> <target> <name>
  move field <path> <target> <field> <--after|--before|--first|--last <ref>
  order fields <path> <target> <f1> <f2> ...
  rm <type|table|entity|extension> <path> [--entity <e>] [--group <g>] [--force]
  fmt [--check] <path>                              format schema files in place
  update table <path> <identity> --extensible <true|false>
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
      if (kind === undefined || !['types', 'tables', 'entities', 'extensions'].includes(kind)) {
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
      if (sub !== 'sql' && sub !== 'model' && sub !== 'atlas-yaml') {
        writeError(`project target must be sql|model|atlas-yaml, got "${sub ?? ''}"`);
        return 64;
      }
      const { values, repeated, positionals } = extractFlags(rest.slice(1), {
        valueFlags: ['--dialect', '--out'],
        repeatFlags: ['--physical-schema'],
        boolFlags: ['--json', '--quiet'],
      });
      const path = positionals[0];
      if (path === undefined) {
        writeError('project requires a path');
        return 64;
      }

      if (sub === 'sql') {
        return await projectSqlCommand({
          path,
          dialect: values['--dialect'],
          out: values['--out'],
          physicalSchemas: repeated['--physical-schema'] ?? [],
        });
      }
      if (sub === 'atlas-yaml') {
        return await projectAtlasCommand({
          path,
          dialect: values['--dialect'],
          physicalSchemas: repeated['--physical-schema'] ?? [],
        });
      }
      return await projectModelCommand({
        path,
        dialect: values['--dialect'],
        physicalSchemas: repeated['--physical-schema'] ?? [],
      });
    }

    case 'init': {
      const system = parseFlag(rest, '--system').value;
      const moduleVal = parseFlag(rest, '--module').value ?? 'core';
      const noExample = rest.includes('--no-example');
      const force = rest.includes('--force');
      const pathArg = rest.find((a) => !a.startsWith('--') && a !== system && a !== moduleVal);
      if (pathArg === undefined) {
        writeError('init requires a path');
        return 64;
      }
      if (system === undefined) {
        writeError('init requires --system');
        return 64;
      }
      return await initCommand({
        path: pathArg,
        system,
        module: moduleVal,
        noExample,
        force,
      });
    }

    case 'new': {
      const sub = rest[0];
      const tail = rest.slice(1);
      if (tail.length === 0) {
        writeError('new requires a kind (type|table|entity|extension)');
        return 64;
      }

      switch (sub) {
        case 'type': {
          const formFlag = parseFlag(tail, '--form').value ?? 'struct';
          const path = tail.find((a) => !a.startsWith('--') && a !== formFlag);
          if (path === undefined) {
            writeError('new type requires <path> <sys.mod.Name>');
            return 64;
          }
          const identity = tail.find((a) => !a.startsWith('--') && a !== path && a !== formFlag);
          if (identity === undefined) {
            writeError('new type requires <sys.mod.Name>');
            return 64;
          }
          return await newTypeCommand({
            path,
            identity: identity as string,
            form: formFlag as 'scalar' | 'struct' | 'enum',
          });
        }
        case 'table': {
          const path = tail[0];
          const identity = tail[1];
          if (path === undefined || identity === undefined) {
            writeError('new table requires <path> <sys.mod.Name>');
            return 64;
          }
          return await newTableCommand({ path, identity });
        }
        case 'entity': {
          const tableFlag = parseFlag(tail, '--table').value;
          if (tableFlag === undefined) {
            writeError('new entity requires --table <table:...>');
            return 64;
          }
          const path = tail.find((a) => !a.startsWith('--') && a !== tableFlag);
          if (path === undefined) {
            writeError('new entity requires <path> <sys.mod.Name>');
            return 64;
          }
          const identity = tail.find((a) => !a.startsWith('--') && a !== path && a !== tableFlag);
          if (identity === undefined) {
            writeError('new entity requires <sys.mod.Name>');
            return 64;
          }
          return await newEntityCommand({ path, identity, table: tableFlag });
        }
        case 'extension': {
          const entityFlag = parseFlag(tail, '--entity').value;
          const groupFlag = parseFlag(tail, '--group').value;
          const ownerFlag = parseFlag(tail, '--owner').value ?? 'platform';
          if (entityFlag === undefined) {
            writeError('new extension requires --entity <entity:...>');
            return 64;
          }
          const path = tail.find(
            (a) => !a.startsWith('--') && a !== entityFlag && a !== groupFlag && a !== ownerFlag,
          );
          if (path === undefined) {
            writeError('new extension requires <path>');
            return 64;
          }
          const groupName = groupFlag ?? 'default';
          return await newExtensionCommand({
            path,
            entity: entityFlag,
            group: groupName,
            owner: ownerFlag,
          });
        }
        default:
          writeError(`new kind must be type|table|entity|extension, got "${sub}"`);
          return 64;
      }
    }

    case 'add': {
      const sub = rest[0];
      if (sub !== 'field') {
        writeError(`add requires "field", got "${sub ?? ''}"`);
        return 64;
      }
      const tail = rest.slice(1);
      const required = tail.includes('--required');
      const unique = tail.includes('--unique');
      const columnFlag = parseFlag(tail, '--column').value;
      const { values: argPairs, remaining: afterArgs } = parseFlagAll(tail, '--args');
      const positionals = afterArgs
        .filter((a) => !a.startsWith('--'))
        .filter((a) => a !== columnFlag);
      const [path, target, name, type] = positionals;
      if (path === undefined || target === undefined || name === undefined || type === undefined) {
        writeError('add field requires <path> <target> <name> <type>');
        return 64;
      }
      const args = argPairs.length > 0 ? parseArgsPairs(argPairs) : undefined;
      return await addFieldCommand({
        path,
        target,
        name,
        type,
        ...(required ? { required: true } : {}),
        ...(unique ? { unique: true } : {}),
        ...(columnFlag !== undefined ? { column: columnFlag } : {}),
        ...(args ? { args } : {}),
      });
    }

    case 'rm': {
      const sub = rest[0];
      const tail = rest.slice(1);
      const force = tail.includes('--force');

      if (sub === 'field') {
        const positionals = tail.filter((a) => !a.startsWith('--'));
        const [path, target, name] = positionals;
        if (path === undefined || target === undefined || name === undefined) {
          writeError('rm field requires <path> <target> <name>');
          return 64;
        }
        return await rmFieldCommand({ path, target, name });
      }

      // rm type/table/entity <path> <identity>
      if (sub === 'type' || sub === 'table' || sub === 'entity') {
        const positionals = tail.filter((a) => !a.startsWith('--'));
        const [path, identity] = positionals;
        if (path === undefined || identity === undefined) {
          writeError(`rm ${sub} requires <path> <identity>`);
          return 64;
        }
        return await rmNodeCommand({ path, identity: `${sub}:${identity}`, force });
      }

      if (sub === 'extension') {
        const entityFlag = parseFlag(tail, '--entity').value;
        const groupFlag = parseFlag(tail, '--group').value;
        if (entityFlag === undefined) {
          writeError('rm extension requires --entity <entity:...>');
          return 64;
        }
        const path = tail.find((a) => !a.startsWith('--') && a !== entityFlag && a !== groupFlag);
        if (path === undefined) {
          writeError('rm extension requires <path>');
          return 64;
        }
        return await rmExtensionCommand({
          path,
          entity: entityFlag,
          group: groupFlag,
          force,
        });
      }

      writeError(`rm requires field|type|table|entity|extension, got "${sub ?? ''}"`);
      return 64;
    }

    case 'move': {
      const sub = rest[0];
      if (sub !== 'field') {
        writeError(`move requires "field", got "${sub ?? ''}"`);
        return 64;
      }
      const tail = rest.slice(1);
      const afterFlag = parseFlag(tail, '--after').value;
      const beforeFlag = parseFlag(tail, '--before').value;
      const first = tail.includes('--first');
      const last = tail.includes('--last');
      const positionals = tail.filter(
        (a) => !a.startsWith('--') && a !== afterFlag && a !== beforeFlag,
      );
      const [path, target, field] = positionals;
      if (path === undefined || target === undefined || field === undefined) {
        writeError('move field requires <path> <target> <field>');
        return 64;
      }
      return await moveFieldCommand({
        path,
        target,
        field,
        after: afterFlag,
        before: beforeFlag,
        first: first || undefined,
        last: last || undefined,
      });
    }

    case 'order': {
      const sub = rest[0];
      if (sub !== 'fields') {
        writeError(`order requires "fields", got "${sub ?? ''}"`);
        return 64;
      }
      const tail = rest.slice(1);
      const positionals = tail.filter((a) => !a.startsWith('--'));
      const [path, target, ...fieldOrder] = positionals;
      if (path === undefined || target === undefined || fieldOrder.length === 0) {
        writeError('order fields requires <path> <target> <field1> <field2> ...');
        return 64;
      }
      return await orderFieldsCommand({ path, target, order: fieldOrder });
    }

    case 'fmt': {
      const tail = rest;
      const checkFmt = tail.includes('--check');
      const pathArg = tail.find((a) => !a.startsWith('--'));
      if (pathArg === undefined) {
        writeError('fmt requires a path');
        return 64;
      }
      return await fmtCommand({ path: pathArg, ...(checkFmt ? { check: true } : {}) });
    }

    case 'update': {
      const sub = rest[0];
      if (sub !== 'table') {
        writeError(`update requires "table", got "${sub ?? ''}"`);
        return 64;
      }
      const tail = rest.slice(1);
      const extensibleFlag = parseFlag(tail, '--extensible').value;
      const strategyFlag = parseFlag(tail, '--strategy').value;
      const flagValues = new Set([extensibleFlag, strategyFlag].filter((v) => v !== undefined));
      const positionals = tail.filter((a) => !a.startsWith('--') && !flagValues.has(a));
      const [path, identity] = positionals;
      if (path === undefined || identity === undefined) {
        writeError('update table requires <path> <identity> --extensible <true|false>');
        return 64;
      }
      return await updateTableCommand({
        path,
        identity,
        strategy: strategyFlag,
        ...(extensibleFlag !== undefined ? { extensible: extensibleFlag } : {}),
      });
    }

    default:
      writeError(`unknown command "${cmd}"`);
      usage();
      return 64;
  }
}

const code = await main(process.argv);
process.exit(code);

/** Parse --args key=value pairs into a record. */
function parseArgsPairs(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const key = pair.slice(0, eq);
      const val = pair.slice(eq + 1);
      // Try to parse as number, otherwise keep as string.
      const num = Number(val);
      out[key] = Number.isNaN(num) ? val : num;
    }
  }
  return out;
}
