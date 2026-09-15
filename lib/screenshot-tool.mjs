/**
 * The `screenshot` tool.
 *
 * The tool does two things in one call that are usually two: it captures the
 * screen, and it hands the model the picture. Returning only a path would
 * leave the agent blind until it thought to call `read_image` — and an agent
 * that has to be told to look twice is not an autonomous eye.
 * @module dsh-screen-eye/screenshot-tool
 */

import { readFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  CAPTURE_MODES,
  CaptureError,
  INTERACTIVE_MODES,
  captureScreen,
  planCapture,
} from './capture.mjs';
import { IMAGE_VALUE_SCHEMA, imageContent } from './image.mjs';
import { DENIED, guidance } from './permission.mjs';
import { pruneCaptures } from './retention.mjs';
import { resolveOutputPath } from './settings.mjs';

const DESCRIPTION = [
  'Capture this macOS screen and return the picture itself, so you can see what is on screen right now.',
  'Use it to inspect a running app, a window, a dialog, an error, or any visual result you cannot read from files — including checking your own UI work.',
  'The image comes back in this call, so there is no need to follow up with read_image.',
  'Requires macOS Screen Recording permission for the process running the harness; when it is missing, the call explains exactly what to grant instead of failing vaguely.',
].join(' ');

/**
 * Build the `screenshot` tool definition.
 * @param ctx - the registration scope, used for the attachments and llm services.
 * @param settings - resolved plugin settings.
 * @param log - a named logger, for diagnostics the model never sees.
 * @returns the tool definition.
 */
export function screenshotTool(ctx, settings, log = noopLogger) {
  return defineTool({
    name: 'screenshot',
    description: DESCRIPTION,
    parameters: {
      mode: {
        type: 'string',
        enum: CAPTURE_MODES,
        description:
          'What to capture. "screen" captures the main display and is the default; "display" captures the single display named by display; "region" captures the rectangle named by region. Every call returns exactly one image, so use display to look at another monitor. "window" and "select" are interactive — they wait for the user to click a window or drag a rectangle, so use them only when the user asked to choose.',
      },
      region: {
        type: 'string',
        description:
          'Required by mode "region": the rectangle to capture as "x,y,w,h" in screen points. The origin is the top-left of the main display, so a display positioned to its left or above takes negative coordinates, for example "-1920,0,800,600". Width and height must be positive.',
      },
      display: {
        type: 'integer',
        description:
          'Which display to capture for mode "display", 1-based (1 is the main display).',
      },
      include_cursor: {
        type: 'boolean',
        description: 'Include the mouse pointer in the capture. Defaults to false.',
      },
      path: {
        type: 'string',
        description:
          'Optional absolute .png path to save the capture to. Defaults to a unique timestamped file in the plugin screenshot directory.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          capturedAt: { type: 'string', required: true },
          display: { type: 'integer' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageContent(value),
      presentationMeta: (_args, value) => ({ path: value.path, mode: value.mode }),
    },
    // Declaring a budget asserts the body forwards exec.signal to a child it
    // can actually kill — see lib/exec.mjs, which does exactly that.
    timeoutMs: settings.timeoutMs,
    // Captures read the screen and write distinct files, so they may overlap.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const plan = planCapture(args);
      if (INTERACTIVE_MODES.has(plan.mode)) {
        log.info(
          'mode "%s" waits for the user to choose; the call blocks until they act',
          plan.mode,
        );
      }

      if (settings.requireImageCapableModel) {
        await assertImageCapableRoute(ctx, exec, plan.mode);
      }

      const outputPath = resolveOutputPath(plan.outputPath, settings.outputDir);
      let captured;
      try {
        captured = await captureScreen(plan, {
          outputPath,
          signal: exec.signal,
          timeoutMs: settings.timeoutMs,
        });
      } catch (error) {
        throw captureFailureError(error, settings.locale);
      }

      const attachments = ctx.get('attachments');
      if (attachments === undefined) {
        throw new Error('cannot capture the screen: no attachment service is mounted');
      }

      const data = await readFile(captured.outputPath);
      const ref = await attachments.saveImage({
        data,
        mediaType: 'image/png',
        name: basename(captured.outputPath),
      });

      let reportedPath = captured.outputPath;
      if (settings.deleteAfterCommit) {
        await unlink(captured.outputPath).catch(() => {});
        reportedPath = '<committed to the attachment store; the temporary PNG was removed>';
      }

      // Housekeeping, after the capture is safely committed: bounded by
      // default so a long session of an agent using its eyes cannot fill the
      // disk with PNGs of the user's screen. Failure here is never fatal.
      //
      // Scoped to the configured directory rather than to wherever this
      // particular capture landed. A caller-supplied `path` may point at a
      // directory the caller keeps for other reasons, and retention has no
      // business walking it looking for files to delete.
      if (settings.keepRecent > 0) {
        await pruneCaptures(
          settings.outputDir,
          settings.keepRecent,
          log,
          basename(captured.outputPath),
        );
      }

      return {
        path: reportedPath,
        mode: plan.mode,
        capturedAt: new Date().toISOString(),
        ...(plan.display === undefined ? {} : { display: plan.display }),
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined
            ? {}
            : { originalDimensions: { ...ref.originalDimensions } }),
        },
      };
    },
  });
}

/**
 * Fallback logger so the tool can be built outside a harness.
 * @type {{ info(...args: unknown[]): void, warn(...args: unknown[]): void }}
 */
const noopLogger = { info() {}, warn() {} };

/**
 * Turn a capture failure into the error the model should read.
 *
 * A denied capture is not an ordinary failure — the remedy is a user action —
 * so it carries the onboarding steps instead of the raw system string.
 *
 * Exported because it is the plugin's most user-visible output: when Screen
 * Recording has not been granted, this message *is* the product, and it has to
 * be assertable without arranging for macOS to deny a real capture.
 *
 * @param error - the thrown error.
 * @param locale - guidance locale.
 * @returns the error the tool should throw.
 */
export function captureFailureError(error, locale) {
  if (error instanceof CaptureError && error.kind === DENIED) {
    return new Error(
      ['Screen capture was refused by macOS.', ...guidance({ locale })].join('\n'),
    );
  }
  if (error instanceof CaptureError) {
    return new Error(
      error.detail === '' ? error.message : `${error.message}: ${error.detail}`,
    );
  }
  return error;
}

/**
 * Refuse the capture when the calling model cannot accept images.
 *
 * Mirroring the built-in `read_image` gate: an image handed to a text-only
 * route is wasted work, and a silent path-only fallback would look like the
 * capture succeeded when the model still cannot see anything.
 * @param ctx - the plugin context, for the optional llm service.
 * @param exec - the tool execution carrying the calling agent.
 * @param mode - the capture mode, used in the message.
 */
async function assertImageCapableRoute(ctx, exec, mode) {
  const routed = exec.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  const llm = ctx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(
      `cannot capture the screen for mode "${mode}": the current model route could not be resolved`,
    );
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal);
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `cannot capture the screen for mode "${mode}": model "${model}" does not declare image input, so it could not see the result; switch to an image-capable model, or set requireImageCapableModel: false to accept captures without a viewer`,
    );
  }
}
