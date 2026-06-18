import type { Diagnostics } from '../errors.js';
import type { AnyFile } from '../ir/schemas.js';
import { ParseError, parseFile } from '../ir/schemas.js';
import type { DiscoveredEntry } from './discovery.js';
import type { FileSystem } from './fs.js';

/**
 * Pass 1 — parse. See spec §13.1.
 *
 * Reads each discovered file's bytes, runs the YAML parser + Zod schema.
 * Failures become `parse` (or `version`) diagnostics; the file is dropped
 * from the parsed map but does not abort the pass.
 *
 * Returns two collections:
 *   - `parsed`: identity → AnyFile for non-extension_fields nodes (unique).
 *   - `extensionFieldsFiles`: list of { identity, owner, file } for every
 *     successfully parsed extension_fields file. Multiple owners may share
 *     an identity; link aggregates them (spec §6.3, §7).
 */
export interface ParseOptions {
  readonly fs: FileSystem;
  readonly files: ReadonlyMap<string, DiscoveredEntry>;
  readonly diagnostics: Diagnostics;
}

export interface ParsedExtensionFields {
  readonly identity: string;
  readonly file: AnyFile;
}

export interface ParseResult {
  readonly parsed: ReadonlyMap<string, AnyFile>;
  readonly extensionFieldsFiles: ReadonlyArray<ParsedExtensionFields>;
  readonly diagnostics: Diagnostics;
}

export async function parseAll(opts: ParseOptions): Promise<ParseResult> {
  const parsed = new Map<string, AnyFile>();
  const extensionFieldsFiles: ParsedExtensionFields[] = [];
  const decoder = new TextDecoder('utf-8');
  for (const entry of opts.files.values()) {
    let bytes: Uint8Array;
    try {
      bytes = await opts.fs.readFile(entry.path);
    } catch (e) {
      opts.diagnostics.add({
        category: 'parse',
        file: entry.path,
        line: 1,
        column: 1,
        message: `failed to read: ${(e as Error).message}`,
      });
      continue;
    }
    const text = decoder.decode(bytes);
    try {
      const f = parseFile(text, entry.path);
      if (f.kind === 'extension_fields') {
        extensionFieldsFiles.push({ identity: entry.identity, file: f });
      } else {
        parsed.set(entry.identity, f);
      }
    } catch (e) {
      // ParseError carries a typed category; everything else is a parse fault.
      const category = e instanceof ParseError && e.category === 'version' ? 'version' : 'parse';
      opts.diagnostics.add({
        category,
        file: entry.path,
        line: 1,
        column: 1,
        message: (e as Error).message,
      });
    }
  }
  return { parsed, extensionFieldsFiles, diagnostics: opts.diagnostics };
}
