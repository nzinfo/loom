import type { FileSystem } from '../../src/loader/fs.js';

/**
 * In-memory FileSystem for tests. Map of path → text content.
 * listFiles walks the keyspace; stat returns synthetic mtime/size.
 */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Uint8Array>();

  constructor(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) {
      this.files.set(k.replace(/\\/g, '/'), new TextEncoder().encode(v));
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const norm = path.replace(/\\/g, '/');
    const buf = this.files.get(norm);
    if (!buf) throw new Error(`ENOENT: ${path}`);
    return buf;
  }

  async *listFiles(dir: string): AsyncIterable<string> {
    const normalized = dir.replace(/\\/g, '/').replace(/\/$/, '');
    const prefix = normalized === '' ? '' : `${normalized}/`;
    const out = new Set<string>();
    for (const key of this.files.keys()) {
      if ((key === normalized || key.startsWith(prefix)) && /\.(ya?ml)$/.test(key)) {
        out.add(key);
      }
    }
    for (const k of out) yield k;
  }

  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const norm = path.replace(/\\/g, '/');
    const buf = this.files.get(norm);
    if (!buf) throw new Error(`ENOENT: ${path}`);
    return { mtimeMs: 0, size: buf.byteLength };
  }
}
