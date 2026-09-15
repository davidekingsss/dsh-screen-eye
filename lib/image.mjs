/**
 * Image content construction.
 *
 * A tool only makes the model *see* something when it returns an `image`
 * content block carrying a durable attachment reference; a file path in the
 * text is not enough. This module mirrors the projection used by the built-in
 * `read_image` tool (`@deepseek-ai/dsh-tool-fs`) so one capture yields exactly
 * the same model-facing shape the harness already knows how to render,
 * downscale and replay.
 * @module dsh-screen-eye/image
 */

/**
 * Structured image metadata carried by the `screenshot` output schema.
 * Field-for-field the same declaration the built-in `read_image` tool uses,
 * so a value produced here traverses the identical validation path.
 */
export const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: {
      type: 'string',
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      required: true,
    },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
};

/**
 * The same declaration with requiredness removed.
 *
 * `mode: "displays"` reports an inventory and captures nothing, so the image
 * property cannot be mandatory for every value the tool returns. The invariant
 * that a capture carries an image is enforced in code and covered by a case,
 * rather than being expressible in a schema that has to fit both shapes.
 */
export const OPTIONAL_IMAGE_VALUE_SCHEMA = (() => {
  const { required: _required, ...optional } = IMAGE_VALUE_SCHEMA;
  return optional;
})();

/**
 * Re-brand a structured image outcome into the durable reference an
 * `ImageBlock` carries. `render` is pure and only receives the canonical
 * value, so the reference is rebuilt from the value's own fields rather than
 * captured from storage.
 * @param image - the image metadata from the output schema.
 * @returns the attachment reference carried by the image block.
 */
export function imageRefFromValue(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined
      ? {}
      : { originalDimensions: { ...image.originalDimensions } }),
  };
}

/**
 * Format one capture as the model-facing envelope that sits beside its image
 * block. When the attachment store downscaled the capture, the envelope names
 * both the stored size and the multiplier that maps coordinates measured on
 * the attached image back onto the original capture.
 * @param value - the capture outcome.
 * @returns the text envelope; the image itself rides the adjacent block.
 */
export function formatImageOutput(value) {
  let scaled = '';
  if (value.image.originalDimensions !== undefined) {
    const x = (value.image.originalDimensions.width / value.image.width).toFixed(2);
    const y = (value.image.originalDimensions.height / value.image.height).toFixed(2);
    const advice = x === y
      ? `multiply coordinates by ${x}`
      : `multiply x coordinates by ${x} and y coordinates by ${y}`;
    scaled = ` (downscaled from ${value.image.originalDimensions.width}x${value.image.originalDimensions.height} px; ${advice} to locate features in the original capture)`;
  }
  return `<path>${value.path}</path>
<capture>mode=${value.mode}${value.display === undefined ? '' : ` display=${value.display}`} at ${value.capturedAt}</capture>
<type>image</type>
<content>
${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes${scaled}
</content>${noteLines(value)}`;
}

/**
 * The engine's own remark about a capture, when it made one.
 *
 * A platform whose captures can succeed and still be unusable — an all-black
 * frame from a locked or disconnected session — says so here rather than
 * withholding the picture: the image is what the screen really shows, and the
 * note is what makes it interpretable. Absent, it contributes nothing, so a
 * capture with nothing to report renders exactly as it always did.
 * @param value - the capture outcome.
 * @returns the note element, prefixed by a newline, or an empty string.
 */
function noteLines(value) {
  return value.note === undefined ? '' : `\n<note>${value.note}</note>`;
}

/**
 * Format a burst as the model-facing envelope that precedes its images.
 *
 * The frames are listed rather than described: the model needs the order and
 * the spacing to reason about what changed, and the per-frame line gives it the
 * path of each one if it wants to re-read or crop a particular frame later.
 * @param value - the burst outcome.
 * @returns the text envelope; the frames ride the adjacent image blocks.
 */
export function formatBurstOutput(value) {
  const count = value.frames.length;
  // Both numbers, because the gap between them is the feedback loop: a capture
  // costs roughly what the region costs to encode, so an interval below the
  // achieved spacing cannot be met, and seeing that is what lets the next call
  // ask for something achievable — typically by watching a smaller region.
  const spacing = value.spacingMs === undefined
    ? 'spacing not measured'
    : value.intervalMs !== undefined && value.intervalMs < value.spacingMs
      ? `taken ${value.spacingMs}ms apart — asked for ${value.intervalMs}ms, which a capture of this size `
        + 'cannot meet; a smaller region is captured faster'
      : `taken about ${value.spacingMs}ms apart`;
  const listed = value.frames.map((frame, index) => {
    const scaled = frame.image.originalDimensions === undefined
      ? ''
      : ` (downscaled from ${frame.image.originalDimensions.width}x${frame.image.originalDimensions.height})`;
    return `  ${index + 1}. ${frame.path} — ${frame.image.width}x${frame.image.height} px${scaled}`;
  });
  const covered = value.durationMs === undefined
    ? ''
    : ` spanning about ${(value.spacingMs ?? 0) * (count - 1)}ms of the ${value.durationMs}ms asked for`;
  return `<capture>mode=${value.mode} frames=${count}, ${spacing}${covered}, starting ${value.capturedAt}</capture>
<frames>
${listed.join('\n')}
</frames>
<type>image</type>
<content>
${count} images follow, in capture order. Compare them to see what moved or changed.
</content>${noteLines(value)}`;
}

/**
 * Project one capture, or one burst, into its model-facing envelope and images.
 * @param value - the capture outcome.
 * @returns the content blocks returned to the model: a text envelope, then one
 *   image block per frame.
 */
export function imageContent(value) {
  if (Array.isArray(value.displays)) {
    const listed = value.displays.map((display) => {
      const size = display.width === undefined ? 'size unknown' : `${display.width}x${display.height}`;
      // Where the display starts, when the platform knows: on Windows a region
      // is addressed in the same coordinates, so an origin is what makes a
      // rectangle on a second screen expressible. macOS reports no origin, and
      // its entries carry neither field and render as they always did.
      const origin = Number.isInteger(display.x) && Number.isInteger(display.y)
        ? ` at ${display.x},${display.y}`
        : '';
      return `  ${display.index}. ${display.name} — ${size}${origin}${display.main ? ' (main display)' : ''}`;
    });
    return [{
      type: 'text',
      text: `<displays count=${value.displays.length}>
${listed.join('\n')}
</displays>
<content>
Nothing was captured. Pass one of these indexes as display with mode "display" to capture it.
</content>`,
    }];
  }
  if (Array.isArray(value.frames) && value.frames.length > 0) {
    return [
      { type: 'text', text: formatBurstOutput(value) },
      ...value.frames.map((frame) => ({
        type: 'image',
        attachment: imageRefFromValue(frame.image),
      })),
    ];
  }
  return [
    { type: 'text', text: formatImageOutput(value) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ];
}
