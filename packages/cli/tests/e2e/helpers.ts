/**
 * E2E test helpers — subprocess-based CLI execution + temp directory factory.
 *
 * Tests run the real CLI entry point (tsx src/main.ts) as a subprocess,
 * capturing stdout/stderr/exit code. This exercises main.ts argument
 * parsing and command dispatch — coverage that unit tests (which call
 * command functions directly) cannot provide.
 */
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry point (run via tsx). */
const CLI_ENTRY = path.resolve(__dirname, '../../src/main.ts');

/** Resolve a path relative to the repo root (for examples/product). */
export function repoRoot(relative: string): string {
  return path.resolve(__dirname, '../../../..', relative);
}

/** Result of a CLI subprocess execution. */
export interface LoomResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the loom CLI as a subprocess.
 *
 * @param args   CLI arguments (e.g. ['check', '--json', '/tmp/xxx'])
 * @param opts   options: cwd (working directory, defaults to repo root)
 * @returns      exit code, stdout, stderr
 */
export async function runLoom(
  args: readonly string[],
  opts?: { cwd?: string },
): Promise<LoomResult> {
  try {
    const result = await execa('npx', ['tsx', CLI_ENTRY, ...args], {
      cwd: opts?.cwd ?? repoRoot('.'),
      encoding: 'utf8',
      reject: false,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    // execa throws on non-zero exit if reject is true; we set reject: false
    // so this should only happen on spawn failure.
    throw new Error(`failed to run loom CLI: ${(err as Error).message}`);
  }
}

/**
 * Run the loom CLI and parse --json output.
 * Automatically adds --json to args if not present.
 */
export async function runLoomJson(
  args: readonly string[],
  opts?: { cwd?: string },
): Promise<{ result: LoomResult; json: unknown }> {
  const jsonArgs = args.includes('--json') ? args : [...args, '--json'];
  const result = await runLoom(jsonArgs, opts);
  if (result.exitCode !== 0) {
    throw new Error(`loom exited ${result.exitCode}: ${result.stderr}`);
  }
  return { result, json: JSON.parse(result.stdout) };
}

// ── temp directory factory ───────────────────────────────────

const tmpDirs: string[] = [];

/**
 * Create a unique temp directory for a test project.
 * Automatically cleaned up after all tests (registered via afterAll).
 */
export function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-e2e-'));
  tmpDirs.push(dir);
  return dir;
}

/** Clean up all temp directories created during the test run. */
export function cleanupTmpDirs(): void {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs.length = 0;
}
