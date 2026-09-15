/**
 * The error a capture engine throws.
 *
 * Its own module rather than part of `capture.mjs` because the engines live
 * behind the platform seam and would otherwise import the module that imports
 * them. `capture.mjs` re-exports it, so callers that knew it from there keep
 * working.
 * @module dsh-screen-eye/capture-error
 */

/** A capture failure that carries the reason the tool layer needs. */
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
