/**
 * The macOS platform.
 *
 * Everything in this plugin that is specific to one operating system is here,
 * or is imported from here and nowhere else: the capture binary and its flags,
 * the display inventory, and the Screen Recording permission model. The tool
 * layer reaches all three through `lib/platform.mjs`, so a second platform can
 * be added without the tools learning about it.
 *
 * `briefing` carries the words the tool description has to say about macOS:
 * what is captured, what gates it, what the interactive modes do, and what a
 * capture costs. They live on the platform because `win32.mjs` answers the same
 * four questions differently, and a description that promised macOS permission
 * prompts on Windows would be worse than saying nothing.
 *
 * See `docs/windows.md` for the second implementation and what it does
 * differently.
 * @module dsh-screen-eye/platform/darwin
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CaptureError } from '../capture-error.mjs';
import { listDisplays } from '../displays.mjs';
import { run } from '../exec.mjs';
import { stripDescriptiveChunks } from '../png.mjs';
import { DEFAULT_TIMEOUT_MS } from '../settings.mjs';
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
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
 * macOS's half of the change check, and the weaker half.
 *
 * Windows keeps an engine resident and compares a few thousand sampled pixels
 * in about 18ms, so it can say *how much* moved. macOS has no helper to ask, so
 * each check runs `screencapture` and compares the bytes with their descriptive
 * chunks stripped — 47ms for a component-sized region, 155ms for a whole 4K
 * screen — and can only say whether anything moved at all. That is why the
 * shared wait requires a change to be confirmed twice before it believes it:
 * one threshold crossing from a hash is not evidence, and a cursor blink is
 * enough to produce one.
 *
 * The chunks have to come off before comparing. `screencapture` stamps every
 * file with a timestamp in an iTXt record, so two captures of a screen that did
 * not change differ byte for byte while the pixels behind them do not —
 * `stripDescriptiveChunks` is the same operation the attachment path uses to
 * make a capture comparable, and it is what makes this check possible at all.
 *
 * @param plan - the validated capture request.
 * @param options - cancellation signal.
 * @returns a hash of the rectangle's current pixels.
 */
async function sampleScreen(plan, options = {}) {
  const target = join(tmpdir(), `dsh-screen-eye-probe-${process.pid}.png`);
  try {
    const result = await run(SCREENCAPTURE, screencaptureArgs(plan, target), {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 20000,
    });
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      throw new CaptureError(
        detail === '' ? `screencapture exited with code ${result.code}` : detail,
        { kind: classifyFailure(detail), detail },
      );
    }
    const data = await readFile(target);
    return createHash('sha256').update(stripDescriptiveChunks(data)).digest('hex');
  } finally {
    await rm(target, { force: true }).catch(() => {});
  }
}

/**
 * Remember what the rectangle looks like now.
 * @param plan - the validated capture request.
 * @param options - cancellation signal.
 */
async function watch(plan, options = {}) {
  baseline = await sampleScreen(plan, options);
}

/**
 * Ask whether anything has changed since {@link watch}.
 *
 * The answer is all-or-nothing here: one comparison, one point. The shared wait
 * treats it as a full change, and leans on its confirmation count and on the
 * caller choosing a region that contains the animation rather than the whole
 * desktop.
 *
 * @param plan - the validated capture request.
 * @param options - cancellation signal.
 * @returns one point, changed or not.
 */
async function changed(plan, options = {}) {
  const current = await sampleScreen(plan, options);
  return { changed: current === baseline ? 0 : 1, total: 1 };
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

/**
 * What the rectangle looked like when `watch` was last called.
 *
 * Module-level because a wait outlives a single call: the caller watches, then
 * asks repeatedly whether the picture has moved. Only one wait is meaningful at
 * a time per process, which is what a tool call is.
 */
let baseline = null;

/** The macOS platform, as `lib/platform.mjs` expects it. */
export const darwin = Object.freeze({
  id,
  capture,
  watch,
  changed,
  listDisplays,
  permission,
  // Both of macOS's remaining modes wait for the user, so neither can be
  // repeated automatically. Written out rather than imported from
  // `lib/capture.mjs` — a platform implementation is the last place that should
  // reach back into the core — and held equal to that module's default by a
  // self-test, so the two cannot drift.
  interactiveModes: new Set(['window', 'select']),
  briefing: {
    surface: 'this macOS screen',
    consent: 'Requires macOS Screen Recording permission for the process running the harness; when it is missing, the call explains exactly what to grant instead of failing vaguely.',
    interactive: '"window" and "select" are interactive — they wait for the user to click a window or drag a rectangle, so use them only when the user asked to choose.',
    timing: 'It is a target, not a promise, and how low it can go depends on the area: a capture costs about 45ms plus encoding, measured at 155ms for a full screen but 56ms for a 1200x800 region, so to resolve a short animation capture the small region it happens in rather than the whole screen.',
  },
});

export { screencaptureArgs as argsFor };
