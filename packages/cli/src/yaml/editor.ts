/**
 * YAML AST editor — read a YAML file, modify its Document AST, write back.
 *
 * Uses the `yaml` library's Document API (parseDocument) which preserves
 * comments, key order, and formatting. This is critical for write commands
 * (add field, move field, etc.) — they edit existing files without
 * reformatting unrelated content.
 */
import * as fs from 'node:fs/promises';
import { type Document, YAMLMap, YAMLSeq, parseDocument, stringify } from 'yaml';

/** Read a YAML file into a mutable Document (preserves formatting). */
export async function readYamlDoc(path: string): Promise<Document.Parsed> {
  const text = await fs.readFile(path, 'utf-8');
  return parseDocument(text);
}

/** Write a Document back to a file. */
export async function writeYamlDoc(path: string, doc: Document.Parsed): Promise<void> {
  const text = doc.toString({ indent: 2, lineWidth: 0 });
  await fs.writeFile(path, `${text}\n`, 'utf-8');
}

/** Serialize a plain object to YAML text (for creating new files). */
export function toYaml(obj: unknown): string {
  return stringify(obj, { indent: 2, lineWidth: 0 });
}

/**
 * Get the `fields` sequence from a YAML doc (table, struct, extension).
 * Returns undefined if the doc has no fields key or it's not a sequence.
 */
export function getFieldsSeq(doc: Document.Parsed): YAMLSeq | undefined {
  const root = doc.contents;
  if (!(root instanceof YAMLMap)) return undefined;
  const fieldsNode = root.get('fields', true);
  if (!(fieldsNode instanceof YAMLSeq)) return undefined;
  return fieldsNode;
}

/**
 * Find a field map in the fields sequence by field name.
 * Returns the index and the map node, or undefined.
 */
export function findField(
  seq: YAMLSeq,
  fieldName: string,
): { index: number; node: YAMLMap } | undefined {
  for (let i = 0; i < seq.items.length; i++) {
    const item = seq.items[i];
    if (!(item instanceof YAMLMap)) continue;
    const nameNode = item.get('name', true);
    if (nameNode && String(nameNode.toJSON()) === fieldName) {
      return { index: i, node: item };
    }
  }
  return undefined;
}

/**
 * Create a YAML map node representing a field entry.
 */
export function createFieldNode(
  doc: Document.Parsed,
  name: string,
  type: string | { ref: string; args?: Record<string, unknown> },
  options?: {
    required?: boolean | undefined;
    unique?: boolean | undefined;
    column?: string | undefined;
  },
): YAMLMap {
  const fieldMap = doc.createNode({}) as YAMLMap;
  fieldMap.set('name', name);

  if (typeof type === 'string') {
    fieldMap.set('type', type);
  } else {
    const typeMap = doc.createNode({}) as YAMLMap;
    typeMap.set('ref', type.ref);
    if (type.args && Object.keys(type.args).length > 0) {
      typeMap.set('args', type.args);
    }
    fieldMap.set('type', typeMap);
  }

  if (options?.required) fieldMap.set('required', true);
  if (options?.unique) fieldMap.set('unique', true);
  if (options?.column !== undefined) fieldMap.set('column', options.column);

  return fieldMap;
}
