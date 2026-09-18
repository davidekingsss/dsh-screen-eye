/**
 * dsh-screen-eye — an autonomous eye for DeepSeek Harness.
 *
 * One call captures the screen *and* returns the picture, so the agent can
 * look at what is on screen on its own initiative instead of asking the user
 * to take a screenshot. It serves macOS and Windows, and does so by
 * construction rather than by accident: everything OS-specific sits behind the
 * platform seam, so the plugin is a platform-neutral core with one
 * implementation behind it per system.
 *
 * Layout:
 * - `lib/screenshot-tool.mjs` — the `screenshot` tool.
 * - `lib/permission-tool.mjs` — the `screen_permission` tool.
 * - `lib/prompt.mjs`          — what the model is told before it decides to
 *                               look: the standing system-prompt section and
 *                               the `screen-eye` skill.
 * - `lib/platform.mjs`        — the platform seam: selects an implementation
 *                               and documents the contract one must meet.
 * - `lib/platform/darwin.mjs` — the macOS implementation.
 * - `lib/platform/win32.mjs`  — the Windows implementation.
 * - `lib/capture.mjs`         — modes, argument validation and the burst loop;
 *                               dispatches one frame to the platform.
 * - `lib/image.mjs`           — image content blocks, mirroring `read_image`.
 * - `lib/settings.mjs`        — config defaults and output paths.
 * - `lib/retention.mjs`       — bounds the capture directory.
 * - `lib/png.mjs`             — reading and rewriting PNG headers.
 * - `lib/exec.mjs`            — cancellable child-process execution.
 *
 * `lib/permission.mjs` and `lib/displays.mjs` are macOS too, and are imported
 * only by `lib/platform/darwin.mjs` — a self-test case fails if anything
 * outside the seam reaches them, or any other OS-specific module.
 *
 * @module dsh-screen-eye
 */

import z from '@deepseek-ai/schemastery';

import { isSupportedPlatform, platformFor } from './lib/platform.mjs';
import { screenPermissionTool } from './lib/permission-tool.mjs';
import { registerPromptSection, registerSkill } from './lib/prompt.mjs';
import { screenshotTool } from './lib/screenshot-tool.mjs';
import { DEFAULT_TIMEOUT_MS, resolveSettings } from './lib/settings.mjs';

/** Cordis plugin name. */
export const name = 'dsh-screen-eye';

/**
 * This plugin contributes tools and a prompt section.
 *
 * `systemPrompt` is a hard dependency because the section is not optional
 * decoration: without it the plugin's tools are defined but never chosen, which
 * is the failure this plugin was measured having. The registry is part of every
 * composition that has an agent in it.
 */
export const inject = ['tools', 'systemPrompt'];

/**
 * Settings namespace this plugin owns.
 *
 * The same string is the `settings.plugin.item` key in `client/client.js`, and
 * that pairing by name is the whole mechanism: the settings shell dispatches a
 * card for each namespace the Host serves that some browser plugin claims, and
 * pairs the two without knowing what either means. Two places, one string, and
 * a self-test that reads both so they cannot drift.
 */
export const SETTINGS_NAMESPACE = 'screen-eye';

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
    .description('Directory for captured PNGs. Defaults to a "Screen Eye" folder inside the system pictures folder.'),
  locale: z
    .string()
    .default('en')
    .description('Language of the Screen Recording onboarding text: "en" or "zh".'),
  timeoutMs: z
    .natural()
    .default(DEFAULT_TIMEOUT_MS)
    .description(
      'Time budget for one whole call, including any wait_for_change. The capture gets what the wait did not spend. See lib/settings.mjs for why the default is what it is.',
    ),
  keepRecent: z
    .natural()
    .default(50)
    .description(
      'How many of the newest captures to keep in outputDir. A capture is a few-megabyte PNG and an agent using its eyes takes many, so the directory is bounded by default. Only files this plugin wrote are ever removed. Set to 0 to keep everything.',
    ),
  maxDimension: z
    .natural()
    .default(4096)
    .description(
      'Largest side, in pixels, a capture may have. 4096 is where the provider\'s per-image limit lands once a request carries fifteen or more images, and a burst can carry hundreds. A capture over the cap is refused with its size named rather than resized, so a display larger than this needs the field raised to be captured whole.',
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
  announceCapability: z
    .boolean()
    .default(true)
    .description(
      'Tell the model, in the system prompt, that it can look at the screen, and register the screen-eye skill. Off removes the announcement and leaves the tools working. The standing line follows the switch immediately; the skill follows it as it stood at mount, because a skill registration cannot be walked back.',
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
 * @returns true, or false when another plugin already claimed that name.
 */
function registerTool(ctx, log, definition, what, issues) {
  try {
    ctx.tools.register(definition);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordFailure(log, issues, `the ${what} tool is unavailable: ${detail}`);
    return false;
  }
}

/**
 * Record a mount failure on every channel this plugin has.
 *
 * The log is for whoever reads the console and the `issues` array is for the
 * agent, because the harness keeps no log file: a canary written at `error`
 * level does not appear in `dsh web`'s output, so a plugin that failed to
 * register would otherwise look exactly like one that is working.
 *
 * The trailing sentence is written for the likely cause rather than every
 * cause. A section name is namespaced and a taken one means a second copy of
 * this plugin is mounted, which is the same story as a taken tool name and the
 * same fix.
 *
 * @param log - a named logger.
 * @param issues - collects failures for `screen_permission` to report.
 * @param message - what failed, phrased for a reader who sees only this line.
 */
function recordFailure(log, issues, message) {
  issues.push(message);
  log.error('%s — another plugin may already register that name.', message);
}

/**
 * Announce the capability, that being the half of a tool that decides whether
 * it is ever called.
 *
 * Registered next to the tool rather than once at mount, so the standing line
 * exists exactly when there is something behind it. A deployment with no
 * attachment store, or a calling model that cannot see images, gets no capture
 * tool and therefore no sentence claiming one.
 *
 * @param ctx - the registration scope.
 * @param log - a named logger.
 * @param readSettings - reads the current plugin settings.
 * @param issues - collects failures for `screen_permission` to report.
 */
function registerAnnouncement(ctx, log, readSettings, issues) {
  try {
    registerPromptSection(ctx, readSettings);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordFailure(log, issues, `the screen-eye prompt section is unavailable: ${detail}`);
  }
  registerSkill(ctx, log, readSettings().announceCapability);
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

  // The configuration this plugin runs on, and where it comes from.
  //
  // The bundle entry is the *base*: it is what the plugin was mounted with, it
  // is what a deployment that has no settings document gets, and it is what a
  // field falls back to when the user clears it. When the harness's settings
  // service is present the namespace above joins the user's settings document
  // as an override layer, which is what makes these values editable from the
  // settings page and from `settings.yaml` — and, because the source is read
  // per call rather than captured at mount, what makes an edited value take
  // effect without a restart. The tools below read through `readSettings`, so
  // the source moving underneath them is the whole point.
  const entry = Config(config ?? {});
  let source = () => entry;
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
      // The resolved section is schema-validated by construction, so it goes
      // through the same normalisation the entry does — one path, not two.
      setSource: (current) => {
        source = () => Config(current());
      },
      // Nothing here derives from settings at mount time, so a change has
      // nothing to re-judge: the next call reads the new value.
      onChange: () => {},
    });
  });
  const readSettings = () => resolveSettings(source());

  // Registration order matters for reporting: the permission tool is built
  // first so that a later failure has somewhere to be reported from, and it
  // reads this array at call time rather than at build time.
  const issues = [];
  const platform = platformFor();
  // No gate means no tool. A platform where capture needs no consent has
  // nothing for `screen_permission` to report, and registering it anyway would
  // offer the model a question with no answer.
  if (platform.permission !== null) {
    registerTool(
      ctx,
      log,
      screenPermissionTool(platform.permission, readSettings, issues),
      'screen_permission',
      issues,
    );
  }

  // `screenshot` exists only while a durable attachment store is mounted:
  // without one there is nowhere to commit the image, and handing back a bare
  // path would defeat the point of the tool.
  ctx.inject(['attachments'], (imageCtx) => {
    const mounted = registerTool(
      imageCtx,
      log,
      screenshotTool(imageCtx, readSettings, log),
      'screenshot',
      issues,
    );
    // Paired with the tool on purpose. A schema answers "how do I call this"
    // only for a caller that already decided to look it up; the section is what
    // puts the capability in front of the model while it is still choosing.
    // Announcing it where the tool did not mount would advertise a call that
    // returns nothing.
    if (mounted) registerAnnouncement(imageCtx, log, readSettings, issues);
  });

  log.info('mounted: captures land in %s', readSettings().outputDir);
}
