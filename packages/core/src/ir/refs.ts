/**
 * `$ref` parse/format helpers. See spec §3.5.
 *
 * A ref string is `<kind>:<system>.<module>.<Name>` (fully-qualified) or
 * `<kind>:.<Name>` (short form, system/module resolved by the loader against
 * the current file's context).
 */
import type { FileKind } from './version.js';

export interface Ref {
  readonly kind: FileKind;
  readonly system: string;
  readonly module: string;
  readonly name: string;
}

const REF_KINDS = new Set<FileKind>([
  'base_types',
  'module_manifest',
  'value_type',
  'mixin',
  'table',
  'entity',
  'extension_fields',
]);

/**
 * Parse a ref string into structured form. Throws on malformed input —
 * callers should catch and emit a `parse` diagnostic with file:line context.
 */
export function parseRef(s: string): Ref {
  const colon = s.indexOf(':');
  if (colon < 0) throw new Error(`invalid $ref: ${s}`);
  const kind = s.slice(0, colon) as FileKind;
  if (!REF_KINDS.has(kind)) throw new Error(`invalid $ref kind: ${s}`);
  const body = s.slice(colon + 1);
  // Fully-qualified: system.module.Name. Short-form: .Name.
  const parts = body.split('.');
  if (parts.length === 2 && parts[0] === '') {
    // ".Name"
    const name = parts[1];
    if (name === undefined || name === '') throw new Error(`invalid $ref: ${s}`);
    return { kind, system: '', module: '', name };
  }
  if (parts.length === 3) {
    const system: string | undefined = parts[0];
    const module: string | undefined = parts[1];
    const name: string | undefined = parts[2];
    if (system === undefined || module === undefined || name === undefined) {
      throw new Error(`invalid $ref: ${s}`);
    }
    if (system === '' || module === '' || name === '') {
      throw new Error(`invalid $ref: ${s}`);
    }
    return { kind, system, module, name };
  }
  throw new Error(`invalid $ref: ${s}`);
}

/** Format a structured Ref back to canonical string form. */
export function formatRef(r: Ref): string {
  if (r.system === '' && r.module === '') {
    return `${r.kind}:.${r.name}`;
  }
  return `${r.kind}:${r.system}.${r.module}.${r.name}`;
}
