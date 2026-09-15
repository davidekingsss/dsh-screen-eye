/**
 * PNG geometry, read from the file header.
 *
 * A capture is checked against a maximum side before it is committed, and that
 * check must not require decoding the image: a full-screen PNG is a few
 * megabytes and its dimensions sit in the first 24 bytes. Reading them from
 * the header keeps the check free and keeps this plugin free of an image
 * library, which is the same reason the capture itself shells out to the
 * system binary.
 *
 * A PNG begins with an 8-byte signature, then the IHDR chunk: a 4-byte length,
 * the 4-byte type `IHDR`, then width and height as 4-byte big-endian integers.
 * @module dsh-screen-eye/png
 */

/** The eight bytes every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read a PNG's pixel dimensions.
 * @param data - the file's bytes.
 * @returns the width and height.
 * @throws when the bytes are not a PNG, or end before the header does.
 */
export function pngDimensions(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) {
    throw new Error('not a PNG: fewer than 24 bytes');
  }
  if (!data.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG: the file signature does not match');
  }
  if (data.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('malformed PNG: the first chunk is not IHDR');
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error(`malformed PNG: ${width}x${height}`);
  }
  return { width, height };
}
