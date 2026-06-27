/**
 * `loom init <path> --system <sys> --module <mod>`
 *
 * Creates a new loom schema project skeleton:
 *   - directory structure (platform/<sys>/<mod>/)
 *   - all 18 built-in scalar type files
 *   - an example table + entity (unless --no-example)
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { BUILTIN_SCALARS, scalarObject } from '../scalars.js';
import { writeError, writeText } from '../shared/output.js';
import { toYaml } from '../yaml/editor.js';

export interface InitOptions {
  readonly path: string;
  readonly system: string;
  readonly module: string;
  readonly noExample: boolean;
  readonly force: boolean;
}

export async function initCommand(opts: InitOptions): Promise<number> {
  const root = opts.path;
  const modDir = path.join(root, 'platform', opts.system, opts.module);

  try {
    await fs.access(modDir);
    if (!opts.force) {
      writeError(`directory already exists: ${modDir} (use --force to overwrite)`);
      return 3;
    }
  } catch {
    // doesn't exist — good
  }

  await fs.mkdir(modDir, { recursive: true });

  const created: string[] = [];

  // Write all 18 scalar type files.
  for (const def of BUILTIN_SCALARS) {
    const filePath = path.join(modDir, `${def.name}.type.yaml`);
    await fs.writeFile(filePath, toYaml(scalarObject(def)), 'utf-8');
    created.push(filePath);
  }

  // Example table + entity.
  if (!opts.noExample) {
    const ns = `${opts.system}.${opts.module}`;
    const tablePath = path.join(modDir, 'items.table.yaml');
    await fs.writeFile(
      tablePath,
      toYaml({
        version: 'loom-schema/v2',
        name: 'Items',
        table: {
          name: `${opts.system}_${opts.module}_example`,
        },
        using: [`${ns}.*`],
        fields: [
          { name: 'id', type: 'bigint', required: true },
          { name: 'label', type: { ref: 'string', args: { max_length: 100 } }, required: true },
        ],
        primary_key: ['id'],
      }),
      'utf-8',
    );
    created.push(tablePath);

    const entityPath = path.join(modDir, 'item.entity.yaml');
    await fs.writeFile(
      entityPath,
      toYaml({
        version: 'loom-schema/v2',
        name: 'Item',
        primary_table: `table:${ns}.Items`,
        business_keys: ['label'],
      }),
      'utf-8',
    );
    created.push(entityPath);
  }

  writeText(
    `initialized ${created.length} file(s) in ${root}/platform/${opts.system}/${opts.module}/`,
  );
  if (!opts.noExample) {
    writeText('\nall 18 built-in scalars available. Example table + entity created.');
    writeText(`run 'loom check ${root}/' to verify.`);
  }
  return 0;
}
