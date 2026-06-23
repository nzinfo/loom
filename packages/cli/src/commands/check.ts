/** `loom check <path>` — load + validate. */
import process from 'node:process';
import { load } from '@loom/core';
import type { GlobalFlags } from '../shared/flags.js';
import { NodeFileSystem } from '../shared/fs.js';
import { writeError, writeJson, writeText } from '../shared/output.js';

export interface CheckOptions {
  readonly path: string;
  readonly flags: GlobalFlags;
}

export async function checkCommand(opts: CheckOptions): Promise<number> {
  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });

  if (result.diagnostics.hasErrors) {
    if (opts.flags.json) {
      const diags = [...result.diagnostics.errors].map((d) => ({
        category: d.category,
        file: d.file,
        line: d.line,
        column: d.column,
        message: d.message,
      }));
      writeJson({ ok: false, path: opts.path, diagnostics: diags });
    } else {
      process.stderr.write(result.diagnostics.format());
      process.stderr.write('\n');
    }
    return 1;
  }

  if (opts.flags.json) {
    writeJson({ ok: true, path: opts.path });
  } else {
    writeText(`ok: ${opts.path}`);
  }
  return 0;
}
