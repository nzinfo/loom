/**
 * Enum variant metadata helpers. See spec §11.
 *
 * Variants carry optional `display_name`/`description` for downstream
 * consumers (UI labels, documentation tools, reverse-engineering). This
 * module formats that metadata into a stable, machine-parseable comment
 * string that dialects emit into DDL, so reverse-engineering tools can
 * recover labels from the database without a side-channel.
 *
 * Comment format contract (stable):
 *   loom:enum <value>[=<display_name>][;<description>](|<entry>)*
 *
 * - `loom:enum` prefix marks loom-injected metadata.
 * - Each entry is `value`, or `value=display_name`, or
 *   `value=display_name;description`.
 * - Entries are `|`-separated (distinct from SQL's `,`-separated value lists).
 * - A variant with neither display_name nor description contributes just `value`.
 *
 * `display_name`/`description` must not contain `|`, `;`, `=`, newlines, or
 * single quotes; these would break the format. (documented limitation)
 */

/** A variant with optional metadata. Source of truth is projector/types.ts. */
export interface EnumVariant {
  /** Variant value — string for string-backed enums, number for integer-backed enums. */
  readonly value: string | number;
  readonly display_name?: string;
  readonly description?: string;
}

/**
 * Characters that would break the comment format if they appear inside a
 * variant's display_name or description value. These are the format's
 * delimiters (`|` `;` `=`) plus newlines and the SQL string quote. We check
 * each metadata value (not the assembled body — that legitimately contains
 * the delimiters) and refuse to emit a structured comment if any value
 * trips one, rather than emit malformed/unparseable DDL.
 */
const FORBIDDEN_VALUE = /[|;=\n\r']/;

function hasForbiddenChar(variants: ReadonlyArray<EnumVariant>): boolean {
  return variants.some(
    (v) =>
      (v.display_name !== undefined && FORBIDDEN_VALUE.test(v.display_name)) ||
      (v.description !== undefined && FORBIDDEN_VALUE.test(v.description)),
  );
}

/**
 * True if any variant carries display_name or description worth emitting.
 * Bare-string variants (no metadata) → false → dialects skip the comment.
 */
export function enumHasMetadata(variants: ReadonlyArray<EnumVariant>): boolean {
  return variants.some((v) => v.display_name !== undefined || v.description !== undefined);
}

/**
 * Format variants into the structured comment body:
 *   active=Active;the active state|inactive|suspended=Suspended
 *
 * Returns `undefined` when there is no metadata, or when any metadata value
 * contains a forbidden character (delimiters/newlines/quote), signaling the
 * caller to omit the comment entirely rather than emit malformed DDL.
 */
export function formatEnumCommentBody(variants: ReadonlyArray<EnumVariant>): string | undefined {
  if (!enumHasMetadata(variants)) return undefined;
  if (hasForbiddenChar(variants)) return undefined;

  const parts = variants.map((v) => {
    const value = String(v.value);
    const name = v.display_name;
    const desc = v.description;
    if (name !== undefined && desc !== undefined) return `${value}=${name};${desc}`;
    if (name !== undefined) return `${value}=${name}`;
    if (desc !== undefined) return `${value}=;${desc}`;
    return value;
  });
  return parts.join('|');
}

/**
 * The full loom marker line (without SQL-comment syntax — the caller wraps it
 * into `COMMENT '...'` / `-- ...` as the dialect requires).
 *
 * Returns `undefined` when there is nothing to emit.
 */
export function formatEnumComment(variants: ReadonlyArray<EnumVariant>): string | undefined {
  const body = formatEnumCommentBody(variants);
  if (body === undefined) return undefined;
  return `loom:enum ${body}`;
}

/**
 * Escape a single quote for SQL string literals (PG / MySQL).
 * SQLite uses `--` line comments and is unaffected, but we centralize the
 * rule so callers stay consistent.
 */
export function escapeSqlSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}
