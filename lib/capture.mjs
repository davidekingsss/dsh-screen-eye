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

/** `x,y,w,h`, all non-negative integers. Rejected rather than repaired. */
const REGION_PATTERN = /^\d+,\d+,\d+,\d+$/;

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

  if (mode === 'region') {
    if (typeof args.region !== 'string' || !REGION_PATTERN.test(args.region.trim())) {
      throw new CaptureError(
        `mode "region" requires region as "x,y,w,h" with four non-negative integers; received ${JSON.stringify(args.region)}`,
      );
    }
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
    display = args.display;
  }

  return {
    mode,
    region: mode === 'region' ? args.region.trim() : undefined,
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
