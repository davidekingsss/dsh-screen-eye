/**
 * Plugin settings and capture path resolution.
 *
 * Defaults are deliberate: screenshots land in a dedicated directory under the
 * harness home rather than in the current workspace, so a capture never
 * becomes an untracked file in whatever repository the agent happens to be
 * working in.
 * @module dsh-screen-eye/settings
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Default cooperative budget for one capture, including interactive modes. */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Merge caller config over the defaults. Unknown keys are ignored rather than
 * forwarded, so a typo in `settings.yaml` cannot silently change behaviour.
 * @param config - raw plugin config from the bundle patch.
 * @returns resolved settings.
 */
export function resolveSettings(config = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return {
    outputDir:
      typeof config.outputDir === 'string' && config.outputDir !== ''
        ? config.outputDir
        : join(dshHome, 'screen-eye'),
    locale: typeof config.locale === 'string' ? config.locale : 'en',
    timeoutMs:
      Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    // Refusing up front beats spending a capture on a model that cannot see it.
    requireImageCapableModel: config.requireImageCapableModel !== false,
    // Off by default: keeping the PNG makes the returned path re-readable and
    // lets the user look at what the agent saw.
    deleteAfterCommit: config.deleteAfterCommit === true,
  };
}

/**
 * Resolve where one capture lands.
 *
 * The timestamp is second-resolution, so a random suffix is what actually
 * guarantees uniqueness: two captures in the same second — an easy thing for
 * an agent to do — must not overwrite each other.
 * @param requested - the model-supplied path, if any.
 * @param outputDir - the configured default directory.
 * @returns an absolute output path.
 */
export function resolveOutputPath(requested, outputDir) {
  if (requested !== undefined && requested !== '') {
    if (!isAbsolute(requested)) {
      throw new Error(`path must be absolute; received ${JSON.stringify(requested)}`);
    }
    if (!requested.toLowerCase().endsWith('.png')) {
      throw new Error(
        `path must name a .png file, because the capture is written as PNG; received ${JSON.stringify(requested)}`,
      );
    }
    return requested;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/gu, '-')
    .replace('T', '_')
    .slice(0, 19);
  const unique = Math.random().toString(36).slice(2, 8);
  return join(outputDir, `shot-${stamp}-${unique}.png`);
}
