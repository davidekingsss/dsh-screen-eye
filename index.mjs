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

import { isSupportedPlatform } from './lib/capture.mjs';
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
  maxDimension: z
    .natural()
    .default(8192)
    .description(
      'Largest side, in pixels, a capture may have. The provider caps a side at 8192 (4096 when a request carries fifteen or more images) and the attachment store caps it at 8192 too; a single display never reaches either. A capture over the cap is refused with its size named, not silently resized.',
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
 * Register one tool without letting a failure escape `apply`.
 *
 * A registration can fail for reasons this plugin does not control — the most
 * likely being that another installed plugin already claimed the name, since
 * the tool registry rejects duplicates. Letting that throw would abort the
 * whole boot: a thrown `apply` takes the entire harness down with it, which
 * turns "you have two screenshot plugins" into "your harness will not start".
 * A plugin's failure must stay the plugin's failure.
 *
 * Logging alone would not be enough. This was verified rather than assumed: a
 * canary written at `error` level does not appear anywhere in `dsh web`'s
 * output, and the harness keeps no log file by default. A plugin that failed
 * to register would therefore look exactly like a plugin that is working, so
 * the failure is also recorded in `issues`, which `screen_permission` reports —
 * that being the tool an agent reaches for when the screen misbehaves.
 *
 * @param ctx - the registration scope.
 * @param log - a named logger.
 * @param definition - the tool definition to register.
 * @param what - the tool name, for the message.
 * @param issues - collects failures for `screen_permission` to report.
 */
function registerTool(ctx, log, definition, what, issues) {
  try {
    ctx.tools.register(definition);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `the ${what} tool is unavailable: ${detail}`;
    issues.push(message);
    log.error('%s — another plugin may already register that name.', message);
  }
}

/**
 * Mount the plugin.
 *
 * The `cordis.patch.yml` entry already carries a platform gate, which stops the
 * module being imported at all where there is no engine. This check stays as
 * well: a direct mount that bypasses the patch must not register capture tools
 * on a platform that has no capture engine. It asks the engine registry rather
 * than naming a platform, so the two cannot disagree.
 *
 * @param ctx - the registration scope.
 * @param config - normalised plugin config.
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger(name);

  // Asked of the engine registry rather than of a platform name: the registry
  // is where "which platforms can this serve" is actually decided, and a second
  // hand-written copy of that answer is a copy that goes stale the moment an
  // engine is added.
  if (!isSupportedPlatform(process.platform)) {
    log.info('not mounted: no capture engine for host platform %s', process.platform);
    return;
  }

  const settings = resolveSettings(config);
  // Registration order matters for reporting: the permission tool is built
  // first so that a later failure has somewhere to be reported from, and it
  // reads this array at call time rather than at build time.
  const issues = [];
  registerTool(ctx, log, screenPermissionTool(settings, issues), 'screen_permission', issues);

  // `screenshot` exists only while a durable attachment store is mounted:
  // without one there is nowhere to commit the image, and handing back a bare
  // path would defeat the point of the tool.
  ctx.inject(['attachments'], (imageCtx) => {
    registerTool(imageCtx, log, screenshotTool(imageCtx, settings, log), 'screenshot', issues);
  });

  log.info('mounted: captures land in %s', settings.outputDir);
}
