/**
 * Global flag parsing — shared --json / --quiet / --dialect helpers.
 *
 * All flag parsers follow the same pattern: scan `rest` for a flag name,
 * extract its value (or presence), return the remaining positional args.
 */

export interface GlobalFlags {
  readonly json: boolean;
  readonly quiet: boolean;
}

/** Extract --json and --quiet from the arg list, returning them + remaining args. */
export function parseGlobalFlags(args: readonly string[]): {
  flags: GlobalFlags;
  remaining: string[];
} {
  let json = false;
  let quiet = false;
  const remaining: string[] = [];
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a === '--quiet' || a === '-q') quiet = true;
    else remaining.push(a);
  }
  return { flags: { json, quiet }, remaining };
}

/** Parse a --flag value pair, returning value + remaining args. */
export function parseFlag(
  rest: readonly string[],
  name: string,
): { value: string | undefined; remaining: string[] } {
  const idx = rest.indexOf(name);
  if (idx < 0) return { value: undefined, remaining: [...rest] };
  const value = rest[idx + 1];
  const remaining = [...rest.slice(0, idx), ...rest.slice(idx + 2)];
  return { value, remaining };
}

/** Parse all occurrences of a repeatable flag. */
export function parseFlagAll(
  rest: readonly string[],
  name: string,
): { values: string[]; remaining: string[] } {
  const values: string[] = [];
  let remaining = [...rest];
  for (;;) {
    const r = parseFlag(remaining, name);
    if (r.value === undefined) break;
    values.push(r.value);
    remaining = r.remaining;
  }
  return { values, remaining };
}

/** Parse --flag=value style (single occurrence). */
export function parseEqualsFlag(
  rest: readonly string[],
  prefix: string,
): { values: string[]; remaining: string[] } {
  const values: string[] = [];
  const remaining: string[] = [];
  for (const a of rest) {
    if (a.startsWith(prefix)) {
      values.push(a.slice(prefix.length));
    } else {
      remaining.push(a);
    }
  }
  return { values, remaining };
}
