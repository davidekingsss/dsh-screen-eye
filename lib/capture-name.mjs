/**
 * The capture filename shape — one definition, used to write names and to
 * recognise them again.
 *
 * These two uses must not drift. Retention decides what it may delete by
 * matching this pattern, so if the builder and the matcher disagree, retention
 * either stops working silently or starts matching files it did not create.
 * Keeping both in one module is what makes that impossible.
 * @module dsh-screen-eye/capture-name
 */

/** Leading `shot-`, so a match is always traceable to this plugin. */
const PREFIX = 'shot-';

/** Timestamp: `YYYY-MM-DD_HH-MM-SS`, in UTC. */
const STAMP = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/u;

/** Disambiguator appended to the timestamp. */
const SUFFIX = /^[a-z0-9]{6}$/u;

/** Matches exactly the names {@link buildCaptureName} produces. */
export const CAPTURE_FILE_PATTERN = /^shot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-z0-9]{6}\.png$/u;

/**
 * Render the timestamp component.
 *
 * The time is UTC and the separators are rewritten so the name is safe on
 * every filesystem a capture might land on. Whole seconds only: sub-second
 * precision lives in the disambiguator instead, which keeps names sortable.
 * @param date - the capture time.
 * @returns the timestamp component.
 */
export function captureStamp(date) {
  return date.toISOString().replace(/[:.]/gu, '-').replace('T', '_').slice(0, 19);
}

/**
 * Build a capture filename.
 *
 * The stamp alone is second-resolution, so an agent capturing twice in the
 * same second — an easy thing for it to do — would otherwise overwrite its
 * own previous capture. The caller supplies the disambiguator.
 * @param date - the capture time.
 * @param random - a six-character lowercase alphanumeric suffix.
 * @returns the filename.
 */
export function buildCaptureName(date, random) {
  if (!SUFFIX.test(random)) {
    throw new Error(`capture disambiguator must be six lowercase alphanumerics; received ${JSON.stringify(random)}`);
  }
  const stamp = captureStamp(date);
  if (!STAMP.test(stamp)) {
    throw new Error(`capture timestamp did not render as expected: ${JSON.stringify(stamp)}`);
  }
  return `${PREFIX}${stamp}-${random}.png`;
}

/**
 * Whether a name is one this plugin wrote.
 * @param name - a bare filename, not a path.
 * @returns whether retention may consider it.
 */
export function isCaptureName(name) {
  return CAPTURE_FILE_PATTERN.test(name);
}
