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
  DEFAULT_BURST_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  INVENTORY_MODE,
  INTERACTIVE_MODES,
  MAX_BURST_FRAMES,
  captureFrames,
  captureScreen,
  planCapture,
} from './capture.mjs';
import { IMAGE_VALUE_SCHEMA, OPTIONAL_IMAGE_VALUE_SCHEMA, imageContent } from './image.mjs';
import { describeCaptureFailure, platformFor } from './platform.mjs';
import { pngDimensions, stripDescriptiveChunks } from './png.mjs';
import { pruneCaptures } from './retention.mjs';
import { resolveOutputPath } from './settings.mjs';

/**
 * The parts of the tool description that are true everywhere, in the order they
 * read. The platform's `briefing` supplies `surface`, `consent`, the sentence
 * about the interactive modes and the one about what a capture costs, because
 * those four are exactly the sentences that would be false on another system.
 */
const DESCRIPTION_HEAD = 'Capture';
const DESCRIPTION_BODY = [
  'and return the picture itself, so you can see what is on screen right now.',
  'Use it to inspect a running app, a window, a dialog, an error, or any visual result you cannot read from files — including checking your own UI work.',
  'The image comes back in this call, so there is no need to follow up with read_image.',
].join(' ');
const DESCRIPTION_FRAMES = 'Set frames above 1 to watch something move: the frames are taken at a fixed interval and all come back in this one call, which is how a process that changes over time can be seen. Recording a GIF is not an option here — the harness stores images single-frame, so an animated GIF would arrive as its first frame.';

/**
 * Build the `screenshot` tool definition.
 * @param ctx - the registration scope, used for the attachments and llm services.
 * @param settings - resolved plugin settings.
 * @param log - a named logger, for diagnostics the model never sees.
 * @returns the tool definition.
 */
export function screenshotTool(ctx, settings, log = noopLogger) {
  // Read once, at build time: the briefing describes the machine this process
  // is on, which cannot change while it runs.
  const briefing = platformFor().briefing;
  const description = [
    `${DESCRIPTION_HEAD} ${briefing.surface}`,
    DESCRIPTION_BODY,
    briefing.consent,
    DESCRIPTION_FRAMES,
  ].join(' ');
  return defineTool({
    name: 'screenshot',
    description,
    parameters: {
      mode: {
        type: 'string',
        enum: CAPTURE_MODES,
        description:
          'What to capture. "screen" captures the main display and is the default; "display" captures the single display named by display; "region" captures the rectangle named by region; "displays" captures nothing and lists the connected displays with the index display expects, so you can find out whether a second monitor exists.' + ` ${briefing.interactive}`,
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
      frames: {
        type: 'integer',
        description:
          `How many captures to take, all returned in this call. Defaults to 1 — one capture. Use it to watch motion — `
          + `a spinner, an animation, a dialog appearing — which a single capture cannot show. Frames, interval_ms and `
          + `duration_ms describe one burst and any two of them determine the third; giving all three is refused. `
          + `At most ${MAX_BURST_FRAMES} per call, because each frame is an image and they share the harness's `
          + 'per-message image budget. Not available with the interactive modes.',
      },
      duration_ms: {
        type: 'integer',
        description:
          'How much real time to cover, in milliseconds — a few hundred for a UI animation, a couple of seconds for a '
          + 'window opening. Give it alone and the window is sampled at the ordinary frame count. Give it with frames to '
          + 'choose how coarsely the window is sampled, or with interval_ms to sample it as densely as that allows.',
      },
      interval_ms: {
        type: 'integer',
        description:
          `Gap between frames in milliseconds. Raising it is how you spend fewer images on the same window, so this is `
          + 'the cost lever: frames x one image each is what the burst costs, and a coarser sample over the same span '
          + `costs proportionally less. ${briefing.timing} `
          + `Defaults to ${DEFAULT_BURST_INTERVAL_MS} when a frame count is given without one; the reply reports the `
          + 'spacing actually achieved.',
      },
      path: {
        type: 'string',
        description:
          'Optional absolute .png path to save the capture to. Defaults to a unique timestamped file in the plugin screenshot directory.',
      },
      wait_for_change: {
        type: 'boolean',
        description:
          'Start the burst when the picture changes, instead of when this call arrives — the frames begin the moment something moves, which is what a transition that runs ONCE needs: say you are watching, ask the user to trigger it, and the burst catches it from the start. '
          + 'What it watches is the region the frames come from, so pick that deliberately. A component-sized region is the precise choice: a small animation changes a large share of the points sampled there, and little else in it moves. The whole screen is the right choice when everything is expected to move — a page load, a video, a full-screen app — and the wrong one when only one part should, because anything else that moves then starts the burst first, and a small animation spread across a whole screen may change too few sampled points to be noticed at all. '
          + 'A transition shorter than about 100ms can be over before a change is confirmed; for those, capture the region directly and compare the frames you get.',
      },
      wait_timeout_ms: {
        type: 'integer',
        description:
          `How long wait_for_change waits for something to move, in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}. It has to cover everything between this call being made and the animation starting — the user has to read your message asking them to trigger it, then trigger it — so raise it when they are expected to take a while. If nothing moves in that window the call fails and says so, rather than returning frames of a screen that never changed.`,
      },
      until_still: {
        type: 'boolean',
        description:
          'Stop the burst when the picture stops changing, instead of taking every frame asked for. frames then becomes an upper bound, and the reply says how many were taken and why it ended. This is ON AUTOMATICALLY whenever wait_for_change is set and more than one frame is asked for: a burst that waited for a transition is a recording of that transition, and the transition ending is where it stops — you do not have to ask for it. Set false to keep taking frames to the end of a fixed window you asked for by duration_ms or frames, which is a different job: a recording of a span rather than of an event. '
          + 'The reason it exists at all is that the length of the motion is usually not knowable in advance: eight frames of a 300ms transition are three frames of motion and five of a screen that has stopped, while three frames of a 900ms one miss two thirds of it. It does not shorten anything that loops, because a loop never settles; but it also cannot help you there, since a loop has no end to stop at.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        // The three capture shapes do not share a required set: a burst has no
        // single `image`, and the inventory has no path, no timestamp and no
        // image at all. Requiredness is therefore enforced per shape in code,
        // and this declaration has to accept every shape or the harness refuses
        // a value the tool legitimately produced.
        properties: {
          path: { type: 'string' },
          mode: { type: 'string', required: true },
          capturedAt: { type: 'string' },
          display: { type: 'integer' },
          image: OPTIONAL_IMAGE_VALUE_SCHEMA,
          displays: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                name: { type: 'string', required: true },
                width: { type: 'integer' },
                height: { type: 'integer' },
                // Where this display's top-left corner sits in the coordinate
                // space `region` is expressed in. A platform that does not
                // report it simply leaves both out, which is why neither is
                // required.
                x: { type: 'integer' },
                y: { type: 'integer' },
                main: { type: 'boolean' },
              },
            },
          },
          frames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                capturedAt: { type: 'string', required: true },
                image: IMAGE_VALUE_SCHEMA,
              },
            },
          },
          spacingMs: { type: 'integer' },
          intervalMs: { type: 'integer' },
          durationMs: { type: 'integer' },
          // Why the burst stopped: `frames` means it took everything it was
          // asked for, `still` means the picture settled and it stopped early.
          endedBecause: { type: 'string', enum: ['frames', 'still'] },
          // An observation about a capture that was taken but may not be
          // usable — an all-black frame, or one the engine had to scale. It
          // rides beside the image rather than replacing it: the picture is
          // what the screen really shows, and the note is what the model needs
          // in order to interpret it.
          note: { type: 'string' },
        },
      },
      render: (_args, value) => imageContent(value),
      // Must be lossless JSON: the harness snapshots this and refuses the whole
      // call when it is not, and a property holding `undefined` is not. The
      // inventory has no path, so it is omitted rather than set to nothing.
      presentationMeta: (_args, value) => ({
        mode: value.mode,
        ...(value.path === undefined ? {} : { path: value.path }),
      }),
    },
    // Declaring a budget asserts the body forwards exec.signal to a child it
    // can actually kill — see lib/exec.mjs, which does exactly that.
    timeoutMs: settings.timeoutMs,
    // Captures read the screen and write distinct files, so they may overlap.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Which modes hand control to the user is a platform fact — macOS's
      // `window` waits for a click, Windows' does not — so planning is told
      // rather than left to assume the macOS answer everywhere.
      const platform = platformFor();
      const interactive = platform.interactiveModes ?? INTERACTIVE_MODES;
      const plan = planCapture(args, { interactiveModes: interactive });
      if (interactive.has(plan.mode)) {
        log.info(
          'mode "%s" waits for the user to choose; the call blocks until they act',
          plan.mode,
        );
      }

      // The inventory mode reports and returns, and it does so *before* the
      // image-capability gate: it captures nothing and returns no image, so
      // asking which displays exist must work even on a route that cannot see
      // — otherwise the one mode that could explain the situation is the one
      // mode a text-only model is refused.
      if (plan.mode === INVENTORY_MODE) {
        const displays = await platform.listDisplays({ signal: exec.signal });
        return { mode: INVENTORY_MODE, displays };
      }

      if (settings.requireImageCapableModel) {
        await assertImageCapableRoute(ctx, exec, plan.mode);
      }

      const outputPath = resolveOutputPath(plan.outputPath, settings.outputDir);
      // Each frame needs its own path. When the plugin chooses the names it
      // asks for a fresh one per frame, so every frame keeps the shape that
      // retention recognises and can therefore be pruned; a caller-supplied
      // path is expanded instead, on the same terms as the single-frame case.
      const framePath = plan.frames === 1
        ? () => outputPath
        : plan.outputPath === undefined
          ? () => resolveOutputPath(undefined, settings.outputDir)
          : (index) => outputPath.replace(/\.png$/iu, `-${index + 1}.png`);

      const attachments = ctx.get('attachments');
      if (attachments === undefined) {
        throw new Error('cannot capture the screen: no attachment service is mounted');
      }

      let shots;
      let spacingMs;
      let endedBecause;
      try {
        if (plan.frames === 1) {
          shots = [await captureScreen(plan, {
            outputPath,
            signal: exec.signal,
            timeoutMs: settings.timeoutMs,
          })];
        } else {
          const burst = await captureFrames(plan, {
            outputPath,
            framePath,
            signal: exec.signal,
            timeoutMs: settings.timeoutMs,
          });
          shots = burst.frames;
          spacingMs = burst.spacingMs;
          endedBecause = burst.endedBecause;
        }
      } catch (error) {
        throw captureFailureError(error, settings.locale);
      }

      const frames = [];
      const notes = [];
      for (const shot of shots) {
        if (shot.note !== undefined) notes.push(shot.note);
        const data = await readFile(shot.outputPath);
        assertWithinDimension(data, settings.maxDimension, plan.mode);
        // Commit the bytes without their descriptive chunks, but leave the file
        // on disk exactly as macOS wrote it: the file is the user's, and its
        // colour profile is meaningful to them, while the stored copy is only
        // ever read back as sRGB.
        const ref = await attachments.saveImage({
          data: stripDescriptiveChunks(data),
          mediaType: 'image/png',
          name: basename(shot.outputPath),
        });

        let reportedPath = shot.outputPath;
        if (settings.deleteAfterCommit) {
          await unlink(shot.outputPath).catch(() => {});
          reportedPath = '<committed to the attachment store; the temporary PNG was removed>';
        }

        // Housekeeping, after each frame is safely committed: bounded by
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
            basename(shot.outputPath),
          );
        }

        frames.push({
          path: reportedPath,
          capturedAt: new Date().toISOString(),
          image: imageValue(ref),
        });
      }

      const shared = {
        mode: plan.mode,
        ...(plan.display === undefined ? {} : { display: plan.display }),
        // Anything the engine said about a frame it took but may not be usable —
        // a black screen, a capture it had to scale. Collected across the burst
        // and deduplicated, so a six-frame burst of a locked session says the
        // reason once instead of six times.
        ...(notes.length === 0 ? {} : { note: [...new Set(notes)].join(' ') }),
      };
      if (frames.length === 1) {
        return { ...shared, path: frames[0].path, capturedAt: frames[0].capturedAt, image: frames[0].image };
      }
      return {
        ...shared,
        path: frames[0].path,
        capturedAt: frames[0].capturedAt,
        frames,
        ...(spacingMs === undefined
          ? {}
          : {
            spacingMs,
            intervalMs: plan.intervalMs,
            ...(plan.durationMs === undefined ? {} : { durationMs: plan.durationMs }),
            ...(endedBecause === undefined ? {} : { endedBecause }),
          }),
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
  return platformFor().permission?.describeFailure(error, describeCaptureFailure, { locale })
    ?? describeCaptureFailure(error);
}

/**
 * Project a stored attachment reference into the serialisable image value.
 *
 * `render` is pure and only receives the canonical value, so the reference has
 * to be carried as plain fields and rebuilt there.
 * @param ref - the reference the attachment store returned.
 * @returns the value's `image` field.
 */
function imageValue(ref) {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined
      ? {}
      : { originalDimensions: { ...ref.originalDimensions } }),
  };
}

/**
 * Refuse a capture whose longest side exceeds the configured maximum.
 *
 * Checked before the image is committed, so the failure names the real numbers
 * and the remedy instead of surfacing as a store error about a limit the user
 * never chose. The capture is not resized to fit: see `DEFAULT_MAX_DIMENSION`
 * in `lib/settings.mjs` for why that would cost more than it saves.
 *
 * @param data - the captured PNG's bytes.
 * @param maxDimension - the configured cap, in pixels.
 * @param mode - the capture mode, used in the message.
 */
function assertWithinDimension(data, maxDimension, mode) {
  const { width, height } = pngDimensions(data);
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return;
  throw new Error(
    `the ${mode} capture is ${width}x${height}, and its longest side exceeds the ${maxDimension}px limit `
    + 'configured for this plugin. The provider caps an image side at 8192px, so this capture could not be sent. '
    + 'Raise maxDimension if the cap was set deliberately, or capture a region or a single display instead of '
    + 'the whole screen.',
  );
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
