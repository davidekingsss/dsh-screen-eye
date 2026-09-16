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
import { engineCapture, engineDisplayOrigins, engineFingerprint, engineIsWarm, stopEngine as stopResidentEngine, warmEngine } from './darwin/engine.mjs';

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
 * The display, rectangle and cursor a plan asks for, in the engine's terms.
 *
 * Exported for testing, because this is the mapping that decides *what part of
 * the screen the resident engine reads*, and getting it wrong produces a
 * plausible picture of the wrong place — the failure mode this tool can least
 * afford. `screencapture` takes the same request as flags and a string; the
 * engine takes it as fields, so the two mappings have to agree, and the sizes
 * they produce are compared against each other in a test.
 *
 * @param plan - the validated capture request.
 * @returns the fields an engine request carries.
 */
export function engineTarget(plan) {
  const target = { display: plan.display ?? 1, x: 0, y: 0, width: 0, height: 0, cursor: plan.includeCursor === true };
  if (plan.mode === 'region') {
    // Already validated into "x,y,w,h" by the planner, which is also the shape
    // `screencapture -R` takes and the shape this tool documents to the model.
    const [x, y, width, height] = plan.region.split(',').map(Number);
    return { ...target, x, y, width, height };
  }
  // "screen" and "display" both mean a whole display: the main one, or the one
  // the caller named. A zero size is how the engine is told "the whole display",
  // which is why it is not an error here.
  return target;
}

/**
 * Capture one frame through `screencapture`, the engine of record.
 * @param plan - the validated capture request.
 * @param outputPath - the resolved absolute output path.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the written PNG's path and byte length.
 */
async function captureThroughBinary(plan, outputPath, options) {
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
 * Capture one frame.
 *
 * `screencapture` is the engine of record and the one that runs by default: it
 * is part of macOS, it needs no build step, and a machine that cannot compile
 * the helper still captures exactly as it always did. The resident engine is
 * used only when it is already warm, so no call ever waits for a helper to be
 * built or started — a cold engine is paid for by the call *after* the one that
 * noticed it was cold.
 *
 * Interactive modes never reach the engine: "window" and "select" are
 * `screencapture` asking the user to click, which is not something a helper
 * reading a rectangle can do.
 *
 * @param plan - the validated capture request.
 * @param outputPath - the resolved absolute output path.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the written PNG's path and byte length.
 */
async function capture(plan, outputPath, options) {
  const interactive = plan.mode === 'window' || plan.mode === 'select';
  if (!interactive && engineIsWarm()) {
    try {
      return await engineCapture(engineTarget(plan), outputPath, options);
    } catch (error) {
      // A resident engine is an optimisation with a lifecycle, and a lifecycle
      // can fail: it can die mid-request, wedge, or report that it could not
      // write the file. Every one of those ends here, in the path the plugin
      // used before the engine existed, because the worst case has to be the old
      // speed rather than no picture — a helper that is broken must be invisible
      // rather than fatal. An earlier revision narrowed this to
      // `engine-unavailable`, which a helper's *own* refusal does not carry: a
      // broken helper would then have failed the capture it was meant to speed
      // up, which is the one outcome the fallback exists to prevent.
      //
      // The single failure that does not fall back is a *denial*, because that
      // is not the engine failing but the screen being unreachable: the binary
      // would be refused for the same reason, and retrying would replace the
      // onboarding message the user needs with a second, vaguer error.
      if (error instanceof CaptureError && error.kind === DENIED) throw error;
      return captureThroughBinary(plan, outputPath, options);
    }
  }
  const shot = await captureThroughBinary(plan, outputPath, options);
  // The capture that just worked is the proof that this process may look at the
  // screen, so it is the right moment to build and start the helper behind it:
  // if Screen Recording were missing, this line would not have been reached —
  // the call above would have thrown its onboarding message instead.
  if (!interactive) warmEngine();
  return shot;
}

/**
 * macOS's half of the change check, and the weaker half.
 *
 * Windows compares a few thousand sampled pixels in about 18ms, so it can say
 * *how much* moved. macOS can only say whether anything moved at all, and it has
 * two ways of saying it:
 *
 * - Through the resident engine, a change check reads the rectangle, reduces it
 *   to a 64x64 fingerprint and hashes that in process — about 23ms measured on a
 *   1400x300 region, against 56-90ms for the other path. Resident, this is also
 *   what lets a burst start *inside* a 300ms animation rather than after it:
 *   measured, a watched burst covered 270-348px of a 373px transition through
 *   the engine against 24-98px through the binary, because the binary pays about
 *   45ms of process start before it reads anything.
 * - Without one, each check runs `screencapture` and compares the bytes with
 *   their descriptive chunks stripped — 47ms for a component-sized region, 155ms
 *   for a whole 4K screen.
 *
 * Either way the answer is all-or-nothing, which is why the shared wait requires
 * a change to be confirmed twice before it believes it: one threshold crossing
 * from a hash is not evidence, and a cursor blink is enough to produce one.
 *
 * The chunks have to come off before comparing. `screencapture` may stamp a file
 * with a timestamp in an iTXt record, so two captures of a screen that did not
 * change can differ byte for byte while the pixels behind them do not —
 * `stripDescriptiveChunks` is the same operation the attachment path uses to
 * make a capture comparable, and it is what makes this check possible at all. On
 * the machine this was measured on the two were identical even before stripping,
 * so the stripping is insurance rather than a load-bearing step; it stays
 * because "the encoder happens not to write a timestamp here" is a fact about
 * one macOS release.
 *
 * @param plan - the validated capture request.
 * @param options - cancellation signal.
 * @returns a hash of the rectangle's current pixels.
 */
async function sampleScreen(plan, options = {}) {
  if (engineIsWarm()) {
    try {
      return `engine:${await engineFingerprint(engineTarget(plan), options)}`;
    } catch (error) {
      // Fall through to the binary, exactly as `capture` does and for the same
      // reason: a watcher that gave up because a helper died would turn "watch
      // this animation" into an error about the plugin. A denial is the one
      // exception, because then there is nothing to watch with either engine.
      if (error instanceof CaptureError && error.kind === DENIED) throw error;
    }
  }
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
    return `binary:${createHash('sha256').update(stripDescriptiveChunks(data)).digest('hex')}`;
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

/**
 * The connected displays, with their desktop origins when they can be had.
 *
 * `system_profiler` reports a display's size and whether it is the main one, and
 * nothing about where it sits — so on its own the inventory cannot say where a
 * second screen begins, and a caller has no way to aim a `region` at one. The
 * resident helper knows, because ScreenCaptureKit has to know in order to
 * capture, so its origins are merged in when it is running.
 *
 * The merge is deliberately additive and never a substitute: the profiler
 * remains the source of the list, its order and its names, and the engine only
 * contributes the two fields the profiler lacks. A machine with no helper keeps
 * exactly the inventory it always had, with the origin simply absent — which is
 * the honest answer, and better than a guess that would make every coordinate
 * derived from it look authoritative.
 *
 * @param options - cancellation signal.
 * @returns one entry per display, main first.
 */
async function listDisplaysWithOrigins(options = {}) {
  const displays = await listDisplays(options);
  const origins = engineDisplayOrigins();
  if (origins === undefined) return displays;
  return displays.map((display) => {
    const match = origins.find((candidate) => candidate.index === display.index);
    if (match === undefined) return display;
    return { ...display, x: match.x, y: match.y };
  });
}

/** The macOS platform, as `lib/platform.mjs` expects it. */
export const darwin = Object.freeze({
  id,
  capture,
  watch,
  changed,
  listDisplays: listDisplaysWithOrigins,
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
    timing: 'It is a target, not a promise, and how low it can go depends on the area: a 1200x800 region costs about 56ms and a full screen about 155ms when each frame is its own `screencapture` process, and about 13ms and 82ms once the plugin has its resident helper warm. So to resolve a short animation capture the small region it happens in rather than the whole screen.',
  },
});

/**
 * The resident engine, for the callers that need to know about it.
 *
 * `isWarm` is what `capture` and the change check ask; `stop` exists so a test
 * can prove the process is really gone rather than assume it, which is the one
 * claim in `engine.mjs` that a stub cannot make.
 */
export const engine = Object.freeze({
  isWarm: engineIsWarm,
  stop: stopResidentEngine,
});

export { screencaptureArgs as argsFor, engineTarget as targetFor };
