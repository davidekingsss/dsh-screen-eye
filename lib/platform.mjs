/**
 * The platform seam.
 *
 * Everything this plugin does that depends on the operating system sits behind
 * this module, so the tool layer never imports an OS-specific module and a
 * second platform is a matter of implementing one object rather than finding
 * every place an assumption was made.
 *
 * ## The contract
 *
 * A platform is an object with four members:
 *
 * - `id` — the `process.platform` value it implements.
 * - `capture(plan, outputPath, options)` — take one frame and write it as PNG.
 *   Throws a `CaptureError` whose `kind` says what went wrong. The plan is
 *   already validated and platform-neutral (`lib/capture.mjs`), including the
 *   burst shape; this only has to honour one frame.
 * - `listDisplays(options)` — the connected displays, main first, indexed from
 *   1 as the platform's own display selector numbers them, so the index can be
 *   handed back to `capture` as `plan.display`.
 * - `permission` — how this platform gates screen capture, or `null` where it
 *   does not. A platform with no gate registers no `screen_permission` tool at
 *   all, because there would be nothing for it to report.
 *
 * The permission object is: `probe(options)` returning
 * `{ authorized, reason?, detail? }`; `openSettings(options)`; `grantTarget()`
 * returning the thing a user must grant; `guidance({ locale, target })`
 * returning the lines to show them; and
 * `describeFailure(error, fallback, { locale })`, which turns a capture failure
 * into the message the model should read — the platform knows which failures
 * its own users can act on.
 *
 * ## Keeping the seam from eroding
 *
 * A self-test case asserts that nothing outside `lib/platform/` imports the
 * OS-specific modules. Without it the seam survives exactly until the next
 * convenient import.
 *
 * @module dsh-screen-eye/platform
 */

import { CaptureError } from './capture-error.mjs';
import { darwin } from './platform/darwin.mjs';

/**
 * Registered platforms, by `process.platform` value.
 *
 * Adding an engine means adding an entry here. Nothing else decides whether a
 * platform is served: the runtime gate in `index.mjs` asks this map, and a
 * self-test compares the bundle patch's `!!js` expression against it.
 */
const PLATFORMS = new Map([[darwin.id, darwin]]);

/**
 * The platforms this plugin can serve.
 * @returns the `process.platform` values with an implementation.
 */
export function supportedPlatforms() {
  return [...PLATFORMS.keys()];
}

/**
 * Whether this plugin has an implementation for a platform.
 * @param platform - a `process.platform` value.
 * @returns whether the platform is served.
 */
export function isSupportedPlatform(platform = process.platform) {
  return PLATFORMS.has(platform);
}

/**
 * The implementation for a platform.
 * @param platform - a `process.platform` value.
 * @returns the platform implementation.
 * @throws when there is none — callers are expected to have gated on
 *   {@link isSupportedPlatform} first, so reaching this is a bug rather than a
 *   runtime condition to handle.
 */
export function platformFor(platform = process.platform) {
  const implementation = PLATFORMS.get(platform);
  if (implementation === undefined) {
    throw new Error(
      `dsh-screen-eye has no implementation for platform "${platform}"; it serves ${supportedPlatforms().join(', ')}`,
    );
  }
  return implementation;
}

/**
 * Turn a capture failure into an error carrying its detail, for platforms whose
 * users have nothing to act on beyond the failure itself.
 *
 * A platform with a permission gate supplies its own `describeFailure` and
 * falls back to this for everything else.
 * @param error - the thrown error.
 * @returns the error to throw.
 */
export function describeCaptureFailure(error) {
  if (error instanceof CaptureError) {
    return new Error(error.detail === '' ? error.message : `${error.message}: ${error.detail}`);
  }
  return error;
}
