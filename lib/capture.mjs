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

import { CaptureError } from './capture-error.mjs';
import { platformFor } from './platform.mjs';

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

/**
 * Frame count used when a burst is clearly intended but no count was given.
 *
 * The ordinary case the tool documents: six frames is enough to see a process
 * change without spending the whole image budget on it. A caller who wants more
 * resolution asks for it, and a caller who wants less raises the interval.
 */
export const DEFAULT_BURST_FRAMES = 6;

/**
 * Modes that hand control to the user and therefore cannot run unattended.
 *
 * The default, and macOS's set. Windows declares its own, because its `window`
 * mode means the window already in front rather than one the user is asked to
 * click; callers that know their platform pass that set in, and the pure cases
 * below use this one.
 */
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
 * Validate the model-supplied arguments before any process is spawned.
 *
 * Invalid input is reported, never coerced into a default: a silently
 * substituted region or display would return a plausible image of the wrong
 * thing, which is worse than an error.
 * @param args - raw tool arguments.
 * @param options - the modes this platform hands to the user; defaults to
 *   {@link INTERACTIVE_MODES}.
 * @returns the validated capture request.
 */
export function planCapture(args, options = {}) {
  const interactive = options.interactiveModes ?? INTERACTIVE_MODES;
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

  // The burst is described by three numbers — how many frames, how far apart,
  // over how long — and any two of them determine the third. That is the whole
  // contract, and it is what gives a caller the cost lever: holding the window
  // fixed and raising the interval is how fewer frames, and so fewer images,
  // are asked for. All three at once over-determine it, which is refused rather
  // than resolved, because a caller who set all three has a belief about which
  // wins and guessing wrong is worse than saying so.
  const wantedFrames = args.frames;
  const wantedInterval = args.interval_ms;
  const wantedDuration = args.duration_ms;

  if (wantedFrames !== undefined && wantedInterval !== undefined && wantedDuration !== undefined) {
    throw new CaptureError(
      'frames, interval_ms and duration_ms over-determine the burst; give any two of them, or one',
    );
  }
  if (wantedFrames !== undefined && (!Number.isInteger(wantedFrames) || wantedFrames < 1)) {
    throw new CaptureError(`frames must be a positive integer; received ${JSON.stringify(wantedFrames)}`);
  }
  if (wantedFrames !== undefined && wantedFrames > MAX_BURST_FRAMES) {
    throw new CaptureError(
      `frames is ${wantedFrames}, above the ${MAX_BURST_FRAMES} this tool allows in one call: a burst shares the `
      + 'harness\'s 20-images-per-message budget with the rest of the conversation. Take fewer frames, or '
      + 'repeat the call.',
    );
  }
  if (wantedInterval !== undefined && (!Number.isInteger(wantedInterval) || wantedInterval < 1)) {
    throw new CaptureError(
      `interval_ms must be a positive integer; received ${JSON.stringify(wantedInterval)}`,
    );
  }
  if (wantedDuration !== undefined && (!Number.isInteger(wantedDuration) || wantedDuration < 1)) {
    throw new CaptureError(
      `duration_ms must be a positive integer; received ${JSON.stringify(wantedDuration)}`,
    );
  }

  let frames;
  let intervalMs;
  let durationMs = wantedDuration;

  if (wantedDuration !== undefined) {
    if (wantedFrames !== undefined) {
      // "cover this window with this many frames" — the cost-control form. The
      // interval is whatever divides the window, so asking for fewer frames is
      // asking for a coarser sample, not a shorter one.
      if (wantedFrames < 2) {
        throw new CaptureError(
          `covering a window needs at least two frames; frames is ${wantedFrames}`,
        );
      }
      frames = wantedFrames;
      intervalMs = Math.max(1, Math.round(wantedDuration / (frames - 1)));
    } else if (wantedInterval !== undefined) {
      // "cover this window as densely as this interval allows" — the cap can
      // truncate the window, and the reply reports the span actually covered.
      frames = Math.min(MAX_BURST_FRAMES, Math.max(2, Math.floor(wantedDuration / wantedInterval) + 1));
      intervalMs = wantedInterval;
    } else {
      // A window with no other instruction: sample it at the default frame
      // count rather than at the maximum, because the maximum is the most
      // expensive answer and the caller did not ask for it.
      frames = DEFAULT_BURST_FRAMES;
      intervalMs = Math.max(1, Math.round(wantedDuration / (frames - 1)));
    }
  } else if (wantedFrames !== undefined) {
    frames = wantedFrames;
    intervalMs = wantedInterval ?? DEFAULT_BURST_INTERVAL_MS;
  } else if (wantedInterval !== undefined) {
    // An interval with no frame count implies a burst; the default length is
    // the one the tool documents as the ordinary case.
    frames = DEFAULT_BURST_FRAMES;
    intervalMs = wantedInterval;
  } else {
    frames = 1;
    intervalMs = DEFAULT_BURST_INTERVAL_MS;
  }

  if (interactive.has(mode) && frames > 1) {
    throw new CaptureError(
      `frames is only meaningful for an unattended capture; mode "${mode}" waits for the user to choose, `
      + 'so it cannot be repeated automatically.',
    );
  }

  // Waiting for the picture to change is how a burst catches a one-shot
  // animation. A model cannot know when the user presses the button, and by the
  // time its tool call has been reasoned about and scheduled the animation is
  // usually over: measured, a burst issued at the instant a 300ms transition
  // begins yielded zero usable frames on Windows, and one at best on macOS. So
  // the wait belongs to the caller, and the plugin takes the start of the
  // animation as its cue instead of the start of the call.
  const waitForChange = args.wait_for_change === true;
  const waitTimeoutMs = args.wait_timeout_ms;
  if (waitTimeoutMs !== undefined && !waitForChange) {
    throw new CaptureError(
      `wait_timeout_ms is only meaningful with wait_for_change: true; received ${JSON.stringify(waitTimeoutMs)} on its own`,
    );
  }
  if (waitTimeoutMs !== undefined && (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1)) {
    throw new CaptureError(`wait_timeout_ms must be a positive integer; received ${JSON.stringify(waitTimeoutMs)}`);
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
    ...(waitForChange ? { waitForChange: { timeoutMs: waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS } } : {}),
  };
}

/**
 * How long a burst waits for the picture to change before giving up.
 *
 * Ten seconds is long enough for a person to be asked to trigger something and
 * do it, and short enough that a caller who forgot to trigger anything is told
 * so rather than left hanging until the tool's own budget expires.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 10000;

/**
 * How often the picture is checked while waiting.
 *
 * A target, and the platform's own cost is the floor: the Windows engine answers
 * a check in about 18ms, while macOS has to run `screencapture` for each one and
 * lands nearer 50ms. What this number decides is how late the burst can be to
 * the animation it is watching — a check every 20ms means the first frame lands
 * within about 20ms of the change, once the change has been confirmed.
 */
export const CHANGE_POLL_INTERVAL_MS = 20;

/**
 * How much of the rectangle has to change before it counts as the animation
 * starting.
 *
 * The first version of this waited for *any* difference, and it fired 461ms
 * into a call that was watching a still screen — a cursor blinked inside the
 * rectangle and the burst began before the animation did, which is precisely
 * the failure the wait exists to prevent. So the wait asks how much changed:
 * a quarter of a percent of the sampled points, which a block crossing the
 * rectangle exceeds several times over (measured at 0.8% for a 60px block in a
 * 1300x600 region) and a cursor or a clock tick does not.
 */
export const CHANGE_FRACTION = 0.0025;

/**
 * How many consecutive checks must agree before the change is believed.
 *
 * One threshold crossing can be a coincidence — a window repainting as the user
 * switches to it, a video frame. Requiring two costs one poll interval of
 * alignment (20ms on Windows, 50ms on macOS) and removes the class of false
 * starts that made the first version useless.
 */
export const CHANGE_CONFIRMATIONS = 2;

/**
 * Wait until the rectangle stops looking like it did.
 *
 * @param plan - the validated capture request, carrying `waitForChange`.
 * @param options - cancellation signal.
 * @returns whether a change was seen.
 * @throws a `CaptureError` when the platform cannot watch, because a wait that
 *   cannot observe anything must say so rather than time out in silence.
 */
async function sleepUntilChange(plan, options) {
  const platform = platformFor();
  if (typeof platform.watch !== 'function' || typeof platform.changed !== 'function') {
    throw new CaptureError(
      `wait_for_change is not available on ${process.platform}: this platform has no way to check the screen `
      + 'without capturing it, so the wait would cost more than the animation it is waiting for',
    );
  }
  await platform.watch(plan, options);
  const deadline = Date.now() + plan.waitForChange.timeoutMs;
  let confirmations = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(CHANGE_POLL_INTERVAL_MS, remaining), options.signal);
    const { changed, total } = await platform.changed(plan, options);
    const moved = total > 0 ? changed / total : 0;
    confirmations = moved >= CHANGE_FRACTION ? confirmations + 1 : 0;
    if (confirmations >= CHANGE_CONFIRMATIONS) return true;
  }
}

/**
 * Capture the screen through the engine registered for this platform.
 * @param plan - the validated capture request.
 * @param options - resolved output path, cancellation signal, wall-clock budget.
 * @returns the written PNG's path and byte length.
 */
export async function captureScreen(plan, options) {
  // The gate lives in index.mjs; reaching here on an unserved platform is a bug
  // rather than a runtime condition, so `platformFor` is allowed to throw.
  return platformFor().capture(plan, options.outputPath, options);
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
 * The loop below is the baseline every platform gets, and it is the right one
 * where a capture costs about what the frame costs — on macOS, 45ms of process
 * startup against 155ms of encoding a 4K screen. A platform where the fixed
 * cost dominates instead implements `captureBurst` and takes the whole burst in
 * one engine call; Windows does, because there a single capture costs about a
 * second almost regardless of area, and paying that per frame would make the
 * interval this tool advertises unreachable.
 *
 * @param plan - the validated capture request, including `frames`.
 * @param options - path factory, cancellation signal, wall-clock budget.
 * @returns the frames in capture order, with the spacing actually achieved.
 */
export async function captureFrames(plan, options) {
  const at = options.framePath ?? ((index) => `${options.outputPath}-${index + 1}.png`);
  const platform = platformFor();
  let waited;
  if (plan.waitForChange !== undefined) {
    const seen = await sleepUntilChange(plan, options);
    if (!seen) {
      throw new CaptureError(
        `nothing on screen changed within ${plan.waitForChange.timeoutMs}ms, so there was no animation to watch. `
        + 'The wait exists for a transition that runs once: trigger it while this call is waiting, or drop '
        + 'wait_for_change for something that is already moving.',
      );
    }
    waited = true;
  }
  if (typeof platform.captureBurst === 'function') {
    const burst = await platform.captureBurst(plan, { ...options, framePath: at });
    return waited === true ? { ...burst, waitedForChange: true } : burst;
  }
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
  return { frames, spacingMs: spacing, ...(waited === true ? { waitedForChange: true } : {}) };
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

export { CaptureError };
