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
</content>`;
}

/**
 * Project one capture into its model-facing envelope and image.
 * @param value - the capture outcome.
 * @returns the two content blocks returned to the model.
 */
export function imageContent(value) {
  return [
    { type: 'text', text: formatImageOutput(value) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ];
}
