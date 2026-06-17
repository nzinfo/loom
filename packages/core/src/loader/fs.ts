/**
 * File system abstraction. Core never imports `node:fs` directly;
 * callers inject a concrete adapter. See spec §13.3.
 *
 * This is what makes `@loom/core` environment-agnostic — a future
 * browser build can supply an in-memory FileSystem backed by IndexedDB.
 */
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  listFiles(dir: string): AsyncIterable<string>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
}
