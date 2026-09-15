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

import { classifyFailure, DENIED, SCREENCAPTURE } from './permission.mjs';
import { run } from './exec.mjs';

/** Capture modes the tool exposes, in the order they are documented. */
export const CAPTURE_MODES = ['screen', 'display', 'region', 'window', 'select'];

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

  return {
    mode,
    region,
    display,
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

export { DENIED };
