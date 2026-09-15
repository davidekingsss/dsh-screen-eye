/**
 * Retention for the capture directory.
 *
 * A capture is a full-resolution PNG of the user's screen — a few megabytes
 * each — and an agent that is using its eyes will take many of them. Left
 * alone, one working session is enough to put tens of them, and tens of
 * megabytes, on disk. Measured rather than assumed: a single end-to-end run
 * of this plugin's own verification left 35 captures behind.
 *
 * So captures are pruned, and the pruning is deliberately narrow:
 *
 * - only the configured output directory, so a capture the caller directed
 *   somewhere else with an explicit `path` never turns that directory into a
 *   place retention walks;
 * - only direct children of it, never recursive;
 * - only regular files whose names match the exact shape this plugin writes
 *   (`lib/capture-name.mjs`), so a user's own `shot-*.png` is never a
 *   candidate;
 * - only the oldest, keeping the newest N;
 * - never the capture that was just taken.
 *
 * `keepRecent: 0` turns it off entirely.
 * @module dsh-screen-eye/retention
 */

import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isCaptureName } from './capture-name.mjs';

/**
 * Decide which captures to delete.
 *
 * Names produced by this plugin share a fixed-width, zero-padded timestamp
 * prefix, so sorting them lexicographically orders them chronologically
 * without touching the filesystem.
 *
 * `except` exists because within one second the order is decided by the random
 * disambiguator rather than by time, so "the newest N" is not guaranteed to
 * include the capture the caller just took. Excluding it by name makes that
 * guarantee unconditional, at the cost of keeping one file more than
 * `keepRecent` in that rare case.
 *
 * @param names - bare filenames found in the capture directory.
 * @param keepRecent - how many of the newest captures to keep; 0 disables.
 * @param except - a filename that must never be removed.
 * @returns the names to delete, oldest first.
 */
export function capturesToRemove(names, keepRecent, except) {
  if (!Number.isInteger(keepRecent) || keepRecent <= 0) return [];
  const ours = names.filter(isCaptureName).sort();
  const keep = new Set(ours.slice(Math.max(0, ours.length - keepRecent)));
  if (except !== undefined && ours.includes(except)) keep.add(except);
  return ours.filter((name) => !keep.has(name));
}

/**
 * Prune the capture directory down to its newest `keepRecent` captures.
 *
 * Failure is never fatal: retention is housekeeping, and a capture that was
 * taken successfully must not be reported as failed because a cleanup step
 * could not run. The count is returned so a caller can report it.
 *
 * @param directory - the capture directory.
 * @param keepRecent - how many of the newest captures to keep; 0 disables.
 * @param log - a named logger; pruning is reported so it is not silent.
 * @param except - a filename that must never be removed.
 * @returns how many files were deleted.
 */
export async function pruneCaptures(directory, keepRecent, log, except) {
  if (!Number.isInteger(keepRecent) || keepRecent <= 0) return 0;

  let entries;
  try {
    // withFileTypes, so a directory that happens to carry a capture-shaped
    // name is visible as one and skipped rather than attempted.
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const doomed = capturesToRemove(names, keepRecent, except);
  if (doomed.length === 0) return 0;

  let removed = 0;
  for (const name of doomed) {
    try {
      await unlink(join(directory, name));
      removed += 1;
    } catch {
      // Already gone, or not removable. Either way retention has nothing to
      // add: the next capture will try again.
    }
  }

  if (removed > 0) {
    log?.info?.('pruned %d old capture(s) from %s, keeping the newest %d', removed, directory, keepRecent);
  }
  return removed;
}
