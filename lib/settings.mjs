/**
 * Plugin settings and capture path resolution.
 *
 * Defaults are deliberate: screenshots land in a dedicated directory under the
 * harness home rather than in the current workspace, so a capture never
 * becomes an untracked file in whatever repository the agent happens to be
 * working in.
 * @module dsh-screen-eye/settings
 */

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { buildCaptureName } from './capture-name.mjs';

/** Default cooperative budget for one capture, including interactive modes. */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Default cap on captures kept in the output directory. A capture is a
 * few-megabyte PNG of the user's screen and an agent using its eyes takes
 * many, so the directory is bounded by default rather than growing until
 * somebody notices. `0` disables pruning.
 */
const DEFAULT_KEEP_RECENT = 50;

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
    keepRecent:
      Number.isInteger(config.keepRecent) && config.keepRecent >= 0
        ? config.keepRecent
        : DEFAULT_KEEP_RECENT,
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
 * The timestamp is second-resolution, so the disambiguator is what actually
 * guarantees uniqueness: two captures in the same second — an easy thing for
 * an agent to do — must not overwrite each other. Three random bytes render as
 * exactly six hexadecimal characters; deriving the suffix from `Math.random()`
 * in base 36 does not, because a small draw renders as fewer digits.
 *
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
  return join(outputDir, buildCaptureName(new Date(), randomBytes(3).toString('hex')));
}
