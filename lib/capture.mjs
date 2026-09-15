/**
 * Screen capture engines.
 *
 * One capture is "resolve an output path, run the platform's capture
 * mechanism, hand back a PNG". Engines are registered per platform so the
 * macOS implementation stays readable and a Windows one can be added without
 * touching the tool layer.
 *
 * ## Why the macOS engine shells out
 *
 * `screencapture(1)` is the only capture path that needs **no compiled
 * artefact**: it is present on every install, it is Apple-signed, and it
 * already speaks ScreenCaptureKit internally on current macOS. Shipping a
 * private helper binary would instead mean producing per-architecture builds
 * and an ad-hoc code signature whose hash changes on every rebuild — and a
 * changed hash silently invalidates the user's Screen Recording grant.
 *
 * @module dsh-screen-eye/capture
 */

import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { classifyFailure, SCREENCAPTURE } from './permission.mjs';
import { run } from './exec.mjs';

/** Capture modes the tool exposes, in the order they are documented. */
export const CAPTURE_MODES = ['screen', 'display', 'region', 'window', 'select', 'displays'];

/** The one mode that reports instead of capturing. */
export const INVENTORY_MODE = 'displays';

/**
 * Frames one call may take.
 *
 * The harness allows 20 images per message, and a burst shares that budget
 * with whatever else the conversation already carries, so the cap leaves
 * headroom rather than consuming the whole allowance.
 */
export const MAX_BURST_FRAMES = 10;

/**
 * Default gap between burst frames, in milliseconds.
 *
 * Chosen for the common case — a long dynamic process seen over the whole
 * screen, where six frames over about a second is a useful sample.
 *
 * It is a *target*, and how far it can be met depends on the area: a capture
 * costs about 45ms of process startup plus encoding proportional to the area,
 * measured at 155ms for a full 3840x2160 screen but 56ms for a 1200x800 region.
 * That is why a short animation is watched by capturing a *small region* rather
 * than by asking for a finer interval over the whole screen: at component size
 * a 400ms animation yields seven frames, where full screen yields two. The
 * achieved spacing is reported back, so a request the hardware cannot meet is
 * visible rather than silently rounded.
 */
export const DEFAULT_BURST_INTERVAL_MS = 200;

/**
 * Planning floor for a capture, in milliseconds.
 *
 * The measured minimum across areas — 47ms for a 200x150 region — and the
 * number `duration_ms` uses to decide how many frames fit. Larger areas cost
 * more, up to 155ms for a whole 4K screen, so a plan built on this floor can
 * under-deliver on time for a big region; the reply reports the spacing
 * actually achieved, so the shortfall is visible rather than hidden.
 */
export const MIN_CAPTURE_MS = 50;

/** Modes that hand control to the user and therefore cannot run unattended. */
export const INTERACTIVE_MODES = new Set(['window', 'select']);

/**
 * `x,y,w,h`. The origin may be negative — a display placed to the left of or
 * above the main one occupies negative coordinates, and such a region is
 * perfectly capturable — but a zero or negative size is not a rectangle.
 */
const REGION_PATTERN = /^(-?\d+),(-?\d+),(\d+),(\d+)$/u;

/**
 * Parse and normalise a region argument.
 * @param raw - the model-supplied region string.
 * @returns the normalised `x,y,w,h` string.
 */
function parseRegion(raw) {
  const complaint =
    'region must be "x,y,w,h" with the origin possibly negative and a positive width and height, '
    + `for example "0,0,800,600" or "-1920,0,800,600"; received ${JSON.stringify(raw)}`;
  if (typeof raw !== 'string') throw new CaptureError(complaint);
  const match = REGION_PATTERN.exec(raw.trim());
  if (match === null) throw new CaptureError(complaint);
  const [x, y, width, height] = match.slice(1);
  if (Number(width) < 1 || Number(height) < 1) {
    throw new CaptureError(`region width and height must be at least 1; received ${JSON.stringify(raw)}`);
  }
  return `${x},${y},${width},${height}`;
}

/**
 * A capture failure that carries the reason the tool layer needs to turn into
 * a diagnosis.
 */
export class CaptureError extends Error {
  /**
   * @param message - developer-facing summary.
   * @param options - failure kind plus the raw system output.
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'CaptureError';
    this.kind = options.kind ?? 'capture-failed';
    this.detail = options.detail ?? '';
  }
}

/**
 * Validate the model-supplied arguments before any process is spawned.
 *
 * Invalid input is reported, never coerced into a default: a silently
 * substituted region or display would return a plausible image of the wrong
 * thing, which is worse than an error.
 * @param args - raw tool arguments.
 * @returns the validated capture request.
 */
export function planCapture(args) {
  const mode = args.mode ?? 'screen';
  if (!CAPTURE_MODES.includes(mode)) {
    throw new CaptureError(`unknown mode "${mode}"; expected one of ${CAPTURE_MODES.join(', ')}`);
  }

  // The inventory mode reports which displays exist and captures nothing, so
  // the capture-only arguments are refused rather than quietly ignored.
  if (mode === INVENTORY_MODE) {
    for (const [key, value] of [['region', args.region], ['display', args.display], ['frames', args.frames], ['interval_ms', args.interval_ms], ['duration_ms', args.duration_ms]]) {
      if (value !== undefined) {
        throw new CaptureError(
          `mode "${INVENTORY_MODE}" reports the displays and captures nothing, so ${key} does not apply to it`,
        );
      }
    }
    return { mode, frames: 1, intervalMs: DEFAULT_BURST_INTERVAL_MS, includeCursor: false, outputPath: undefined };
  }

  let region;
  if (mode === 'region') {
    region = parseRegion(args.region);
  } else if (args.region !== undefined) {
    throw new CaptureError(`region is only meaningful with mode "region"; mode is "${mode}"`);
  }

  let display;
  if (args.display !== undefined) {
    if (!Number.isInteger(args.display) || args.display < 1) {
      throw new CaptureError(
        `display must be a positive integer (1 is the first display); received ${JSON.stringify(args.display)}`,
      );
    }
    if (mode !== 'display') {
      throw new CaptureError(`display is only meaningful with mode "display"; mode is "${mode}"`);
    }
    display = args.display;
  }

  // Reassigned below when a duration decides the frame count instead.
  let frames = args.frames ?? 1;
  if (!Number.isInteger(frames) || frames < 1) {
    throw new CaptureError(`frames must be a positive integer; received ${JSON.stringify(args.frames)}`);
  }
  if (frames > MAX_BURST_FRAMES) {
    throw new CaptureError(
      `frames is ${frames}, above the ${MAX_BURST_FRAMES} this tool allows in one call: a burst shares the `
      + 'harness\'s 20-images-per-message budget with the rest of the conversation. Take fewer frames, or '
      + 'repeat the call.',
    );
  }
  if (INTERACTIVE_MODES.has(mode) && frames > 1) {
    throw new CaptureError(
      `frames is only meaningful for an unattended capture; mode "${mode}" waits for the user to choose, `
      + 'so it cannot be repeated automatically.',
    );
  }

  // `duration_ms` states the intent — cover this much real time — and lets the
  // tool size the burst, so a caller does not have to know what a capture costs
  // to ask for a short animation one time and a two-second motion the next.
  // It is exclusive with the explicit knobs rather than overriding them: a
  // caller who set both has a belief about which wins, and guessing wrong is
  // worse than saying so.
  let durationMs;
  if (args.duration_ms !== undefined) {
    if (args.frames !== undefined || args.interval_ms !== undefined) {
      throw new CaptureError(
        'duration_ms decides frames and interval_ms itself; give either duration_ms or those two, not both',
      );
    }
    if (!Number.isInteger(args.duration_ms) || args.duration_ms < 1) {
      throw new CaptureError(
        `duration_ms must be a positive integer; received ${JSON.stringify(args.duration_ms)}`,
      );
    }
    durationMs = args.duration_ms;
  } else if (args.frames !== undefined && args.frames > 1 && args.interval_ms === undefined) {
    // Nothing to do: the frame count was given and the interval has a default.
  }

  let intervalMs;
  if (args.interval_ms !== undefined) {
    if (!Number.isInteger(args.interval_ms) || args.interval_ms < 1) {
      throw new CaptureError(
        `interval_ms must be a positive integer; received ${JSON.stringify(args.interval_ms)}`,
      );
    }
    intervalMs = args.interval_ms;
  } else {
    intervalMs = DEFAULT_BURST_INTERVAL_MS;
  }

  // A duration is spent on as many frames as fit, up to the cap, because more
  // frames sample the motion better; the interval is then whatever divides the
  // window evenly. Two frames is the floor, since one frame is not a burst.
  if (durationMs !== undefined) {
    const fitting = Math.floor(durationMs / MIN_CAPTURE_MS) + 1;
    frames = Math.min(MAX_BURST_FRAMES, Math.max(2, fitting));
    intervalMs = Math.max(1, Math.round(durationMs / (frames - 1)));
  }

  return {
    mode,
    region,
    display,
    frames,
    intervalMs,
    ...(durationMs === undefined ? {} : { durationMs }),
    includeCursor: args.include_cursor === true,
    outputPath: args.path,
  };
}

/**
 * Build the `screencapture` argument vector for a planned capture.
 * Exported so the mapping can be asserted without spawning anything.
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
 * Run the macOS capture engine.
 * @param plan - the validated capture request.
 * @param outputPath - the resolved absolute output path.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the absolute path of the written PNG.
 */
async function captureDarwin(plan, outputPath, options) {
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

/** Platform registry. Only macOS has an engine today. */
const ENGINES = new Map([['darwin', captureDarwin]]);

/**
 * Whether this platform has a capture engine.
 * @param platform - a `process.platform` value.
 * @returns whether capture is supported.
 */
export function isSupportedPlatform(platform = process.platform) {
  return ENGINES.has(platform);
}

/**
 * Capture the screen through the engine registered for this platform.
 * @param plan - the validated capture request.
 * @param options - resolved output path, cancellation signal, wall-clock budget.
 * @returns the written PNG's path and byte length.
 */
export async function captureScreen(plan, options) {
  const engine = ENGINES.get(process.platform);
  if (engine === undefined) {
    throw new CaptureError(
      `dsh-screen-eye has no capture engine for platform "${process.platform}"`,
      { kind: 'unsupported-platform' },
    );
  }
  return engine(plan, options.outputPath, options);
}

/**
 * Capture one frame or a burst of them.
 *
 * A burst is sequential captures at a target interval, not a video: it needs
 * no transcoder, produces the same PNG the single-frame path does, and its
 * frame count is exactly what was asked for. That last property is why it
 * exists rather than a recording — `screencapture -v` is variable-frame-rate
 * and drops duplicates, so a two-second recording of a still screen yields six
 * frames, while six sequential captures yield six frames whatever the screen
 * is doing.
 *
 * Each frame gets its own path, so nothing is overwritten and every frame keeps
 * the same coordinate mapping to the screen.
 *
 * @param plan - the validated capture request, including `frames`.
 * @param options - path factory, cancellation signal, wall-clock budget.
 * @returns the frames in capture order, with the spacing actually achieved.
 */
export async function captureFrames(plan, options) {
  const at = options.framePath ?? ((index) => `${options.outputPath}-${index + 1}.png`);
  const frames = [];
  for (let index = 0; index < plan.frames; index += 1) {
    const startedAt = Date.now();
    if (index > 0 && plan.intervalMs !== undefined) {
      // Sleep the remainder of the target period; a capture that already
      // outran it simply runs again immediately, which is the honest outcome
      // for an interval the hardware cannot meet.
      const wait = plan.intervalMs - (startedAt - frames[index - 1].startedAt);
      if (wait > 0) await sleep(wait, options.signal);
    }
    const captureStart = Date.now();
    const captured = await captureScreen(plan, { ...options, outputPath: at(index) });
    frames.push({ ...captured, startedAt: captureStart, takenAtMs: Date.now() });
  }
  const spacing = frames.length < 2
    ? undefined
    : Math.round((frames.at(-1).startedAt - frames[0].startedAt) / (frames.length - 1));
  return { frames, spacingMs: spacing };
}

/**
 * Wait, without outliving a cancellation.
 * @param ms - how long to wait.
 * @param signal - the caller's cancellation signal.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CaptureError('aborted while waiting between frames', { kind: 'capture-failed' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CaptureError('aborted while waiting between frames', { kind: 'capture-failed' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
