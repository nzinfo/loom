/**
 * `loom version` — emit machine-readable version info for atlas to negotiate.
 * See spec §16.2.
 *
 * Format:
 *   loom <semver>
 *   schema-versions-supported: <family>/<v1>[, ...]
 */
import process from 'node:process';
import { CURRENT_VERSION, FORMAT_FAMILY, FORMAT_VERSION } from '@loom/core';

export const CLI_VERSION = '0.1.0' as const;

export function versionCommand(): void {
  process.stdout.write(`loom ${CLI_VERSION}\n`);
  process.stdout.write(`schema-versions-supported: ${FORMAT_FAMILY}/${FORMAT_VERSION}\n`);
  process.stdout.write(`current: ${CURRENT_VERSION}\n`);
}
