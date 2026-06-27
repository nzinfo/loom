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

/**
 * Extract all flags (and their values) from an arg list in a single pass.
 *
 * Flags that take a value: `--dialect pg` → { dialect: 'pg' }
 * Flags that are boolean: `--json` → { json: true }
 * Repeatable value flags: `--physical-schema a=x` → { physicalSchema: ['a=x'] }
 * Everything else is a positional arg.
 *
 * This replaces the fragile r2/r3 parseFlag chaining in main.ts.
 */
export function extractFlags(
  args: readonly string[],
  opts: {
    valueFlags?: readonly string[];
    boolFlags?: readonly string[];
    repeatFlags?: readonly string[];
  },
): {
  values: Record<string, string | undefined>;
  bools: Record<string, boolean>;
  repeated: Record<string, string[]>;
  positionals: string[];
} {
  const valueFlags = opts.valueFlags ?? [];
  const boolFlags = opts.boolFlags ?? [];
  const repeatFlags = opts.repeatFlags ?? [];

  const values: Record<string, string | undefined> = {};
  const bools: Record<string, boolean> = {};
  const repeated: Record<string, string[]> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;

    // Boolean flags (--json, --force, etc.)
    if (boolFlags.includes(a)) {
      bools[a] = true;
      continue;
    }

    // Value flags (--dialect pg, --out file.sql)
    if (valueFlags.includes(a) && i + 1 < args.length) {
      values[a] = args[++i];
      continue;
    }

    // Repeatable value flags (--physical-schema a=x)
    if (repeatFlags.includes(a) && i + 1 < args.length) {
      const key = a;
      if (!repeated[key]) repeated[key] = [];
      const next = args[++i];
      if (next !== undefined) repeated[key]?.push(next);
      continue;
    }

    // Positional arg
    positionals.push(a);
  }

  return { values, bools, repeated, positionals };
}
