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

/**
 * Chunks that describe the image rather than contain it.
 *
 * macOS attaches all three to every screen capture — an ICC profile named
 * after the display, EXIF, and an iTXt record — and their presence is what
 * decides whether the attachment store keeps the bytes or re-encodes them.
 * Its pass-through test requires the image to carry no metadata, so a real
 * screenshot never qualifies: it is re-encoded to lossy WebP at quality 85
 * however small it is.
 *
 * Dropping them costs nothing that survives anyway. The store's re-encode
 * converts to sRGB and discards the profile regardless, so the stored image is
 * sRGB either way — the difference is only whether it arrives there losslessly.
 * Measured on a 600x400 capture: with the chunks the store refuses it, without
 * them the same pixels pass through byte-for-byte.
 */
const DESCRIPTIVE_CHUNKS = new Set(['iCCP', 'eXIf', 'iTXt', 'tEXt', 'zTXt', 'tIME']);

/**
 * Drop the chunks that only describe a PNG, keeping the image data untouched.
 *
 * This rewrites the chunk list; it does not decode or recompress, so it is
 * lossless, costs about a millisecond, and needs no image library.
 *
 * @param data - the file's bytes.
 * @returns the same image without its descriptive chunks, or the input
 *   unchanged when it is not a PNG this can safely rewrite.
 */
export function stripDescriptiveChunks(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) return data;
  if (!data.subarray(0, 8).equals(SIGNATURE)) return data;
  if (data.subarray(12, 16).toString('latin1') !== 'IHDR') return data;

  const parts = [data.subarray(0, 8)];
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;
    if (end > data.length) return data;
    if (!DESCRIPTIVE_CHUNKS.has(type)) parts.push(data.subarray(offset, end));
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  // An unterminated file is left alone rather than truncated into a corrupt one.
  return sawEnd ? Buffer.concat(parts) : data;
}
