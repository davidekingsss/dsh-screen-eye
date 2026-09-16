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

/**
 * Default cooperative budget for one whole call, including any wait.
 *
 * The budget covers the entire call, waiting included, and the capture gets
 * what the wait left behind rather than a fresh copy of it. That split is the
 * point: a `wait_for_change` is dead time by construction — it exists for a
 * transition nobody has triggered yet — so a budget that a wait could exhaust
 * would silently turn "watch this animation" into "return nothing". Waiting
 * therefore spends the same budget capturing does, and the default is sized so
 * that the worst case the tool advertises still fits: a 30s wait for the
 * trigger plus a burst that may legitimately run for minutes under
 * `until_still`, and still inside the harness's own tool timeout.
 */
export const DEFAULT_TIMEOUT_MS = 300000;

/**
 * Default cap on one side of a capture.
 *
 * 4096, because that is where the provider's own limit lands the moment a
 * request carries more than a handful of images: the documented per-image side
 * limit is 8192, dropping to 4096 once a request holds fifteen or more. A burst
 * can hold hundreds, so the lower number is the one a capture has to satisfy to
 * be *sendable* rather than merely acceptable to the attachment store.
 *
 * It is a cap on what will be produced, not a resize target: a capture whose
 * longest side exceeds it is refused with its size named, because resizing here
 * would insert one more scale between what the model measures in the image and
 * the screen coordinates `region` expects — the one mapping the zoom workflow
 * depends on. The consequence to know about is real and worth stating: a
 * display wider or taller than 4096 px cannot be captured whole at this
 * default, and the fix is to raise this field, not to capture something that
 * comes back refused.
 */
const DEFAULT_MAX_DIMENSION = 4096;

/**
 * Where captures go when nothing says otherwise.
 *
 * The system's own pictures folder, under a directory named for this plugin:
 * a capture belongs with the user's pictures rather than inside the harness's
 * private home, and fifty of them belong in a folder of their own rather than
 * loose among someone's photographs. macOS and Windows both name it
 * `~/Pictures`; a machine that has moved or renamed it keeps the default until
 * someone points `outputDir` at the real path, which is the honest outcome —
 * guessing a relocated folder would mean reading the registry on every call.
 *
 * @returns the default capture directory.
 */
function defaultOutputDir() {
  return join(homedir(), 'Pictures', 'Screen Eye');
}

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
  return {
    outputDir:
      typeof config.outputDir === 'string' && config.outputDir !== ''
        ? config.outputDir
        : defaultOutputDir(),
    locale: typeof config.locale === 'string' ? config.locale : 'en',
    timeoutMs:
      Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    keepRecent:
      Number.isInteger(config.keepRecent) && config.keepRecent >= 0
        ? config.keepRecent
        : DEFAULT_KEEP_RECENT,
    maxDimension:
      Number.isInteger(config.maxDimension) && config.maxDimension > 0
        ? config.maxDimension
        : DEFAULT_MAX_DIMENSION,
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
