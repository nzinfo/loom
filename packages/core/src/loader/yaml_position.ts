/**
 * YAML position tracking — converts character offsets to line:column and
 * looks up the position of a specific YAML path within a document.
 *
 * Used by the parse/link/validate passes to provide accurate line:column
 * in diagnostics instead of the hardcoded 1:1.
 */
import { parseDocument } from 'yaml';

export interface Position {
  readonly line: number;
  readonly column: number;
}

/** Convert a character offset in text to a 1-based line:column position. */
export function offsetToPosition(text: string, offset: number): Position {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

/**
 * Find the position of a YAML path in the source text.
 *
 * If the exact path can't be resolved (e.g. a missing key that Zod reports
 * as an error), walks up the path to find the nearest ancestor that exists.
 *
 * @param text    the original YAML source text
 * @param path    dot-separated path (e.g. "fields.0.name", "primary_key")
 *                numeric segments index into arrays
 * @returns       the position, or undefined if the path can't be resolved
 */
export function findPosition(text: string, path: string): Position | undefined {
  const doc = parseDocument(text);
  const root = doc.contents;
  if (!root) return undefined;

  const segments = path.split('.');
  let node: unknown = root;
  let lastValidNode: unknown = root;

  for (const seg of segments) {
    if (node === null || node === undefined) return undefined;
    // Numeric segment → array index
    if (/^\d+$/.test(seg)) {
      const idx = Number(seg);
      const items = (node as { items?: unknown[] }).items;
      if (!items || idx >= items.length) {
        node = undefined;
        break;
      }
      node = items[idx];
    } else {
      // String key → Map lookup
      const get = (node as { get?: (key: string, keep?: boolean) => unknown }).get;
      if (!get) {
        node = undefined;
        break;
      }
      const next = get.call(node, seg, true);
      if (next === undefined) {
        // Key doesn't exist — stop but keep last valid position.
        break;
      }
      node = next;
    }
    if (node !== undefined) lastValidNode = node;
  }

  // The node should have a `range` property: [startOffset, endOffset, ...]
  // Fall back to lastValidNode if the full path couldn't be resolved.
  const target = node ?? lastValidNode;
  const range = (target as { range?: [number, number, number] }).range;
  if (!range || range.length < 1) return undefined;

  return offsetToPosition(text, range[0]);
}

/**
 * Find the position of a field by name in a YAML document's fields array.
 *
 * Used for extension field errors where we know the field name but not
 * its array index (the entry was aggregated across owners).
 */
export function findPositionByValue(text: string, fieldName: string): Position | undefined {
  const doc = parseDocument(text);
  const root = doc.contents;
  if (!root) return undefined;

  const get = (root as { get?: (key: string, keep?: boolean) => unknown }).get;
  if (!get) return undefined;

  const fieldsNode = get.call(root, 'fields', true);
  const items = (fieldsNode as { items?: unknown[] })?.items;
  if (!items) return undefined;

  for (const item of items) {
    const itemGet = (item as { get?: (key: string, keep?: boolean) => unknown }).get;
    if (!itemGet) continue;
    const nameNode = itemGet.call(item, 'name', true);
    if (nameNode && String((nameNode as { toJSON?: () => unknown }).toJSON?.() ?? nameNode) === fieldName) {
      const range = (item as { range?: [number, number, number] }).range;
      if (range && range.length >= 1) {
        return offsetToPosition(text, range[0]);
      }
    }
  }
  return undefined;
}

/**
 * Try to extract a field name from a Zod error path.
 *
 * Zod error paths look like ['fields', 0, 'type'] or ['primary_key'].
 * We convert to a dot-separated path for findPosition.
 */
export function zodPathToString(path: (string | number)[]): string {
  return path.map(String).join('.');
}
