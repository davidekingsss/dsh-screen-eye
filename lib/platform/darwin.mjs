/**
 * The macOS platform.
 *
 * Everything in this plugin that is specific to one operating system is here,
 * or is imported from here and nowhere else: the capture binary and its flags,
 * the display inventory, and the Screen Recording permission model. The tool
 * layer reaches all three through `lib/platform.mjs`, so a second platform can
 * be added without the tools learning about it.
 *
 * See `docs/windows.md` for what a second implementation has to provide and
 * what could not be determined from macOS.
 * @module dsh-screen-eye/platform/darwin
 */

import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CaptureError } from '../capture-error.mjs';
import { listDisplays } from '../displays.mjs';
import { run } from '../exec.mjs';
import {
  DENIED,
  classifyFailure,
  grantTargetPath,
  guidance,
  openScreenRecordingSettings,
  probeScreenRecording,
  SCREENCAPTURE,
} from '../permission.mjs';

/** `process.platform` value this implements. */
export const id = 'darwin';

/**
 * Build the `screencapture` argument vector for a planned capture.
 *
 * Exported for testing: this mapping is the part of the engine worth asserting
 * without spawning anything.
 * @param plan - the validated capture request.
 * @param outputPath - the resolved absolute output path.
 * @returns the argument vector.
 */
export function screencaptureArgs(plan, outputPath) {
  const argv = ['-x', '-t', 'png'];
  if (plan.includeCursor) argv.push('-C');
  // `-m` pins mode "screen" to the main monitor. Without it, screencapture
  // writes "1 file per screen" (see its manual), so on a multi-display Mac one
  // call would produce several files while this pipeline resolves and reads a
  // single path — some of them would be left behind under names nothing here
  // chose. One image per call is the contract the rest of the code is built
  // on, so the default is one display, and `display` selects another.
  if (plan.mode === 'screen') argv.push('-m');
  if (plan.mode === 'display') argv.push('-D', String(plan.display));
  if (plan.mode === 'region') argv.push('-R', plan.region);
  if (plan.mode === 'window') argv.push('-o', '-w');
  if (plan.mode === 'select') argv.push('-i');
  argv.push(outputPath);
  return argv;
}

/**
 * Capture one frame through `screencapture`.
 * @param plan - the validated capture request.
 * @param outputPath - the resolved absolute output path.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the written PNG's path and byte length.
 */
async function capture(plan, outputPath, options) {
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await run(SCREENCAPTURE, screencaptureArgs(plan, outputPath), {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120000,
  });

  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new CaptureError(
      detail === '' ? `screencapture exited with code ${result.code}` : detail,
      { kind: classifyFailure(detail), detail },
    );
  }

  let size;
  try {
    size = (await stat(outputPath)).size;
  } catch {
    throw new CaptureError('screencapture reported success but wrote no file', {
      kind: 'capture-failed',
    });
  }
  if (size === 0) {
    throw new CaptureError('screencapture wrote an empty file', { kind: 'capture-failed' });
  }
  return { outputPath, bytes: size };
}

/**
 * Turn a capture failure into the message the model should read.
 *
 * A denied capture is not an ordinary failure — the remedy is a user action —
 * so it carries the onboarding steps instead of the raw system string. That
 * string reads like a bug and tells the user nothing they can act on, which is
 * why it is replaced rather than prefixed.
 *
 * @param error - the thrown error.
 * @param fallback - translation for failures that are not permission denials.
 * @param options - guidance locale.
 * @returns the error to throw.
 */
function describeFailure(error, fallback, options = {}) {
  if (error instanceof CaptureError && error.kind === DENIED) {
    return new Error(
      ['Screen capture was refused by macOS.', ...guidance({ locale: options.locale })].join('\n'),
    );
  }
  return fallback(error);
}

/**
 * The Screen Recording permission, as this platform models it.
 *
 * `guide` is deliberately one call rather than two: it checks before opening
 * anything, because reporting a grant missing without having looked would be
 * the plugin asserting what it never observed.
 */
const permission = {
  probe: options => probeScreenRecording(options),
  openSettings: options => openScreenRecordingSettings(options),
  grantTarget: () => grantTargetPath(),
  guidance: options => guidance(options),
  describeFailure,
};

/** The macOS platform, as `lib/platform.mjs` expects it. */
export const darwin = Object.freeze({
  id,
  capture,
  listDisplays,
  permission,
});

export { screencaptureArgs as argsFor };
