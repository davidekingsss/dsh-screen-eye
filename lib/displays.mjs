/**
 * Which displays exist, and which index `screencapture` gives each one.
 *
 * `screencapture -D <n>` numbers displays from 1, with the main display first,
 * and refuses anything above the count with "Must be a number from 1-2". That
 * numbering is what this module reports, so an agent can learn that a second
 * screen exists and which index reaches it.
 *
 * The ordering was checked against the system rather than assumed. On a machine
 * with a 4K monitor and an iPad in Sidecar, `system_profiler` listed the monitor
 * first as `spdisplays_main`, the iPad second, and `-D 1` and `-D 2` captured
 * exactly those two in that order. A single-display machine cannot show this,
 * which is why it went unverified until one was available.
 *
 * `spdisplays_online` is deliberately not required: Sidecar displays omit it,
 * and treating a missing key as "offline" would hide the second screen on
 * exactly the setup this exists to describe.
 * @module dsh-screen-eye/displays
 */

import { run } from './exec.mjs';

/** Where macOS keeps the display inventory. */
const SYSTEM_PROFILER = '/usr/sbin/system_profiler';

/**
 * Read the connected displays.
 * @param options - cancellation signal.
 * @returns one entry per display, in the order `screencapture -D` numbers them.
 */
export async function listDisplays(options = {}) {
  const result = await run(
    SYSTEM_PROFILER,
    ['SPDisplaysDataType', '-json'],
    { signal: options.signal, timeoutMs: 20000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `could not read the display inventory: system_profiler exited with code ${result.code}`
      + (result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`),
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`could not read the display inventory: ${error.message}`);
  }

  return displaysFromProfiler(parsed);
}

/**
 * Turn a `system_profiler` payload into the ordered display list.
 *
 * Split out from the call because the ordering is the part that has to be
 * right and the part that can be checked anywhere: the machine this runs on in
 * CI reports no displays at all, so a case that can only assert against a real
 * inventory would assert nothing there.
 *
 * @param parsed - the decoded `SPDisplaysDataType` payload.
 * @returns one entry per display, main first, indexed from 1.
 * @throws when the payload lists no displays, which means the inventory failed
 *   rather than that the machine has no screen.
 */
export function displaysFromProfiler(parsed) {
  const displays = [];
  for (const gpu of parsed?.SPDisplaysDataType ?? []) {
    for (const entry of gpu.spdisplays_ndrvs ?? []) {
      const size = parsePixels(entry._spdisplays_pixels);
      displays.push({
        // Assigned after sorting, so the index is the one -D expects.
        index: 0,
        name: typeof entry._name === 'string' ? entry._name : 'unknown display',
        ...(size === undefined ? {} : size),
        main: entry.spdisplays_main === 'spdisplays_yes',
      });
    }
  }
  if (displays.length === 0) {
    throw new Error('the display inventory listed no displays');
  }

  // Main first, which is the order -D numbers them in; the rest keep the order
  // macOS reported.
  const ordered = [
    ...displays.filter((display) => display.main),
    ...displays.filter((display) => !display.main),
  ];
  return ordered.map((display, position) => ({ ...display, index: position + 1 }));
}

/**
 * Read a `WIDTH x HEIGHT` string.
 * @param value - the reported pixel size.
 * @returns the dimensions, or undefined when the field is absent or unparseable.
 */
function parsePixels(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)\s*x\s*(\d+)$/u.exec(value.trim());
  if (match === null) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}
