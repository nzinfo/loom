/**
 * Output helpers — JSON vs human-readable switching.
 *
 * Every command that produces structured output calls these helpers.
 * When --json is active, data is serialized as JSON; otherwise formatted
 * for terminal reading.
 */
import process from 'node:process';
import type { GlobalFlags } from './flags.js';

/** Write JSON to stdout (used when --json is active). */
export function writeJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Write plain text to stdout (human-readable mode). */
export function writeText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Write an error message to stderr. */
export function writeError(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

/**
 * Emit output respecting the --json flag.
 * - json=true: serialize `data` as JSON
 * - json=false: write `text`
 */
export function emit(flags: GlobalFlags, data: unknown, text: string): void {
  if (flags.json) {
    writeJson(data);
  } else {
    writeText(text);
  }
}
