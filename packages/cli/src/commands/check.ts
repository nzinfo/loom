/** `loom check` — load + validate. See spec §8.7. */
import { load, type FileSystem } from '@loom/core';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

/** Node.js FileSystem adapter implementing @loom/core's FileSystem interface. */
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
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
          yield full;
        }
      }
    }
  }

  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const s = await fs.stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  }
}

export interface CheckOptions {
  readonly path: string;
  /** Restrict to these systems. */
  readonly systems?: readonly string[];
}

export async function checkCommand(opts: CheckOptions): Promise<number> {
  const result = await load({
    fs: new NodeFileSystem(),
    basePath: opts.path,
    ...(opts.systems !== undefined ? { systemFilter: opts.systems } : {}),
  });

  if (result.diagnostics.hasErrors) {
    process.stderr.write(result.diagnostics.format());
    process.stderr.write('\n');
    return 1;
  }

  process.stdout.write(`ok: ${opts.path}\n`);
  return 0;
}

// Silence unused-import warning for the readline placeholder (will be used
// when adding stdin streaming in later phases).
void createInterface;
