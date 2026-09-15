/**
 * dsh-screen-eye — an autonomous eye for DeepSeek Harness on macOS.
 *
 * One call captures the screen *and* returns the picture, so the agent can
 * look at what is on screen on its own initiative instead of asking the user
 * to take a screenshot. It is macOS-only by construction: the capture engine,
 * the permission model and the onboarding flow are all macOS facts.
 *
 * Layout:
 * - `lib/screenshot-tool.mjs` — the `screenshot` tool.
 * - `lib/permission-tool.mjs` — the `screen_permission` tool.
 * - `lib/capture.mjs`         — capture engines, registered per platform.
 * - `lib/permission.mjs`      — Screen Recording detection and onboarding.
 * - `lib/image.mjs`           — image content blocks, mirroring `read_image`.
 * - `lib/settings.mjs`        — config defaults and output paths.
 * - `lib/exec.mjs`            — cancellable child-process execution.
 *
 * @module dsh-screen-eye
 */

import z from '@deepseek-ai/schemastery';

import { screenPermissionTool } from './lib/permission-tool.mjs';
import { screenshotTool } from './lib/screenshot-tool.mjs';
import { resolveSettings } from './lib/settings.mjs';

/** Cordis plugin name. */
export const name = 'dsh-screen-eye';

/** This plugin contributes tools and needs nothing else to load. */
export const inject = ['tools'];

/**
 * User-editable configuration.
 *
 * The defaults here and the fallbacks in `lib/settings.mjs` must agree; the
 * self-test asserts it, because the two are applied on different paths — this
 * schema when the loader normalises config, and the module when it is called
 * directly.
 */
export const Config = z.object({
  outputDir: z
    .string()
    .description('Directory for captured PNGs. Defaults to <DSH home>/screen-eye.'),
  locale: z
    .string()
    .default('en')
    .description('Language of the Screen Recording onboarding text: "en" or "zh".'),
  timeoutMs: z
    .natural()
    .default(120000)
    .description('Cooperative time budget for one capture, including interactive modes.'),
  keepRecent: z
    .natural()
    .default(50)
    .description(
      'How many of the newest captures to keep in outputDir. A capture is a few-megabyte PNG and an agent using its eyes takes many, so the directory is bounded by default. Only files this plugin wrote are ever removed. Set to 0 to keep everything.',
    ),
  requireImageCapableModel: z
    .boolean()
    .default(true)
    .description(
      'Refuse a capture when the calling model declares no image input, instead of returning a picture it cannot see.',
    ),
  deleteAfterCommit: z
    .boolean()
    .default(false)
    .description(
      'Delete the PNG once it is committed to the attachment store. Off by default so the returned path stays re-readable.',
    ),
});

/**
 * Mount the plugin.
 *
 * The `cordis.patch.yml` entry already carries a platform gate, which stops
 * the module being imported at all on a non-macOS host. This check stays as
 * well: a direct mount that bypasses the patch must not register capture tools
 * on a platform that has no capture engine.
 *
 * @param ctx - the registration scope.
 * @param config - normalised plugin config.
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger(name);

  if (process.platform !== 'darwin') {
    log.info('not mounted: screen capture here is macOS-only (host platform is %s)', process.platform);
    return;
  }

  const settings = resolveSettings(config);
  ctx.tools.register(screenPermissionTool(settings));

  // `screenshot` exists only while a durable attachment store is mounted:
  // without one there is nowhere to commit the image, and handing back a bare
  // path would defeat the point of the tool.
  ctx.inject(['attachments'], (imageCtx) => {
    imageCtx.tools.register(screenshotTool(imageCtx, settings, log));
  });

  log.info('mounted: captures land in %s', settings.outputDir);
}
