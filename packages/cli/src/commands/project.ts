/** `loom project sql --dialect <pg|mysql|sqlite> [--out <file>] <path>`. See spec §8.8. */
import process from 'node:process';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { load, projectSqlFromIr } from '@loom/core';
import type { Dialect, FileSystem } from '@loom/core';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';

class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array> {
    return fs.readFile(path);
  }
  async *listFiles(dir: string): AsyncIterable<string> {
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = `${current}/${entry.name}`;
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) yield full;
      }
    }
  }
  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const s = await fs.stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  }
}

const DIALECTS: readonly Dialect[] = ['pg', 'mysql', 'sqlite'];

export interface ProjectOptions {
  readonly path: string;
  readonly dialect: string | undefined;
  readonly out: string | undefined;
}

export async function projectCommand(opts: ProjectOptions): Promise<number> {
  if (opts.dialect === undefined || !DIALECTS.includes(opts.dialect as Dialect)) {
    process.stderr.write(`error: --dialect must be one of ${DIALECTS.join(', ')}\n`);
    return 64;
  }
  const dialect = opts.dialect as Dialect;

  const result = await load({ fs: new NodeFileSystem(), basePath: opts.path });
  if (result.diagnostics.hasErrors) {
    process.stderr.write(result.diagnostics.format());
    process.stderr.write('\n');
    return 1;
  }

  const sql = projectSqlFromIr(result.ir, dialect);

  const sink: Writable = opts.out ? createWriteStream(opts.out) : process.stdout;
  await new Promise<void>((resolve, reject) => {
    sink.write(sql, (err) => (err ? reject(err) : resolve()));
  });
  if (opts.out) {
    sink.end();
  }
  return 0;
}
