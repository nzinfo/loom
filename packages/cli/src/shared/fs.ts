/**
 * Node.js FileSystem adapter — shared across all CLI commands.
 *
 * Implements @loom/core's FileSystem interface so the engine can read
 * schema files without depending on Node APIs directly.
 */
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileSystem } from '@loom/core';

export class NodeFileSystem implements FileSystem {
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
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))
        ) {
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
