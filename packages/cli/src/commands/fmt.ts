/**
 * `loom fmt <path>`
 *
 * Formats schema YAML files in place: normalizes key order, indentation,
 * and field ordering for diff-stability.
 *
 * Each file kind has a canonical key order. Fields within `fields:` arrays
 * are kept in their original order (field order is semantically meaningful).
 */
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { type Document, parseDocument, stringify } from 'yaml';
import { writeError, writeText } from '../shared/output.js';

export interface FmtOptions {
  readonly path: string;
  readonly check?: boolean; // if true, don't write — just report unformatted files
}

// Canonical key order per file kind (top-level keys).
const KEY_ORDER: Record<string, readonly string[]> = {
  type: [
    'version',
    'name',
    'form',
    'display_name',
    'description',
    'using',
    'properties',
    'fields',
    'variants',
    'constraints',
  ],
  table: [
    'version',
    'name',
    'display_name',
    'description',
    'using',
    'table',
    'fields',
    'primary_key',
    'indexes',
    'foreign_keys',
    'constraints',
  ],
  entity: [
    'version',
    'name',
    'display_name',
    'description',
    'primary_table',
    'business_keys',
    'audit',
    'view',
  ],
  extension_fields: ['version', 'entity', 'group', 'using', 'fields'],
};

// Key order for a type field entry.
const FIELD_KEY_ORDER = ['name', 'type', 'required', 'unique', 'default', 'column'];

// Key order for table.table object.
const TABLE_INNER_ORDER = ['name', 'extension'];

// Key order for table.extension object.
const EXTENSION_ORDER = ['strategy', 'ext_table', 'view'];

export async function fmtCommand(opts: FmtOptions): Promise<number> {
  const files: string[] = [];
  await collectYamlFiles(opts.path, files);

  let unformatted = 0;
  let formatted = 0;

  for (const filePath of files) {
    const original = await fs.readFile(filePath, 'utf-8');
    const doc = parseDocument(original);
    if (doc.errors.length > 0) {
      // Skip files with parse errors — don't touch what we can't parse.
      continue;
    }

    const kind = detectKind(filePath);
    if (kind === null) continue;

    reorderKeys(doc, KEY_ORDER[kind] ?? []);

    // Reorder nested structures.
    reorderTableInner(doc);
    reorderFields(doc);

    const formatted_text = doc.toString({
      indent: 2,
      lineWidth: 0,
      defaultKeyType: 'PLAIN',
    });

    // Ensure trailing newline.
    const normalized = formatted_text.endsWith('\n') ? formatted_text : `${formatted_text}\n`;

    if (normalized !== original) {
      if (opts.check) {
        unformatted++;
        writeText(`would reformat: ${filePath}`);
      } else {
        await fs.writeFile(filePath, normalized, 'utf-8');
        formatted++;
      }
    }
  }

  if (opts.check) {
    if (unformatted > 0) {
      writeText(`\n${unformatted} file(s) need formatting`);
      return 1;
    }
    writeText('all files formatted');
  } else {
    writeText(`formatted ${formatted} file(s)`);
  }
  return 0;
}

/** Detect file kind from the filename suffix. */
function detectKind(filePath: string): string | null {
  const name = path.basename(filePath);
  if (name.endsWith('.type.yaml')) return 'type';
  if (name.endsWith('.table.yaml')) return 'table';
  if (name.endsWith('.entity.yaml')) return 'entity';
  if (name.endsWith('.ext.yaml')) return 'extension_fields';
  return null;
}

/** Reorder top-level keys in a YAML document to match the canonical order. */
function reorderKeys(doc: Document.Parsed, order: readonly string[]): void {
  const root = doc.contents;
  if (!root || typeof root !== 'object' || !('items' in root)) return;

  const items = (root as { items: { key: { value: string }; value: unknown }[] }).items;
  items.sort((a, b) => {
    const ai = order.indexOf(a.key.value);
    const bi = order.indexOf(b.key.value);
    // Unknown keys go to the end, preserving their relative order.
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/** Reorder keys inside table.table and table.table.extension. */
function reorderTableInner(doc: Document.Parsed): void {
  const root = doc.contents as { get?: (key: string, keep?: boolean) => unknown } | null;
  if (!root?.get) return;
  const tableNode = root.get('table', true) as
    | { get?: (key: string, keep?: boolean) => unknown; items?: unknown[] }
    | undefined;
  if (!tableNode?.items) return;
  reorderMapItems(tableNode as { items: { key: { value: string } }[] }, TABLE_INNER_ORDER);

  const extNode = tableNode.get?.('extension', true) as
    | { items?: { key: { value: string } }[] }
    | undefined;
  if (extNode?.items) {
    reorderMapItems(extNode as { items: { key: { value: string } }[] }, EXTENSION_ORDER);
  }
}

/** Reorder keys inside each field entry in the fields array. */
function reorderFields(doc: Document.Parsed): void {
  const root = doc.contents as { get?: (key: string, keep?: boolean) => unknown } | null;
  if (!root?.get) return;
  const fieldsNode = root.get('fields', true) as
    | { items?: { items?: { key: { value: string } }[] }[] }
    | undefined;
  if (!fieldsNode?.items) return;
  for (const field of fieldsNode.items) {
    if (field?.items) {
      reorderMapItems(field as { items: { key: { value: string } }[] }, FIELD_KEY_ORDER);
    }
  }
}

/** Sort a YAML map's items by the given key order. */
function reorderMapItems(
  map: { items: { key: { value: string } }[] },
  order: readonly string[],
): void {
  map.items.sort((a, b) => {
    const ai = order.indexOf(a.key.value);
    const bi = order.indexOf(b.key.value);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/** Recursively collect all .yaml files under a directory. */
async function collectYamlFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectYamlFiles(full, out);
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      out.push(full);
    }
  }
}

// Keep stringify import alive (used if we add non-document-based formatting)
void stringify;
