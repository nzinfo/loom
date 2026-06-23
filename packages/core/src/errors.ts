/**
 * Error category. See spec §13.2.
 *
 * Categories are kept distinct so callers (CI, editors) can react
 * differently. `loom check` fails on any error category.
 */
export type ErrorCategory =
  | 'parse'
  | 'version'
  | 'identity'
  | 'dangling_ref'
  | 'kind_mismatch'
  | 'cycle'
  | 'schema'
  | 'semantic'
  | 'project';

/** Single diagnostic. File path + line + col are required for actionable errors. */
export interface Diagnostic {
  readonly category: ErrorCategory;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  /** Optional hint pointing at the offending source. */
  readonly context?: string;
}

/** Accumulated diagnostics from a load/check/project run. */
export class Diagnostics {
  private readonly items: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.items.push(d);
  }

  get errors(): readonly Diagnostic[] {
    return [...this.items];
  }

  get hasErrors(): boolean {
    return this.items.length > 0;
  }

  /** Format for human-readable stderr output. */
  format(): string {
    return this.items
      .map((d) => `${d.file}:${d.line}:${d.column}: ${d.category}: ${d.message}`)
      .join('\n');
  }
}
