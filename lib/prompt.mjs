/**
 * What the model is told about seeing the screen, before it decides anything.
 *
 * A tool reaches a model through two independent channels: its schema, sent
 * with every request, and a standing line in the system prompt. This plugin
 * shipped with only the first, and the cost was measured rather than guessed —
 * of the sixty sessions in the local store, fifty-four mention `screenshot`
 * once each and every one of those mentions is the same sentence, the Web
 * surface's "the browser provides no implicit DOM, route, or screenshot
 * context". Nothing anywhere described a capture as something the agent could
 * take. The wording was not the fault of this plugin; the silence was.
 *
 * The schema is the wrong place to fix that. A schema is read after the choice
 * to look it up and answers "how do I call this"; nothing reads it while
 * deciding whether the capability exists. The section below is that deciding
 * text, and it is deliberately short: what the capability is, when it applies,
 * and the one property that changes planning — the image arrives in this call,
 * so reading the screen is one step rather than two.
 *
 * The skill repeats it for a reader who arrives through the skill catalog
 * instead, and adds what a standing line has no room for: which mode to reach
 * for, what a scaled display does to coordinates, and how to get unstuck when
 * the grant is missing. It is registered at runtime rather than shipped as a
 * file, so installing the plugin is the whole installation — no copy into a
 * skills directory, and nothing on disk that can drift from the code that
 * describes it.
 *
 * @module dsh-screen-eye/prompt
 */

import { platformFor } from './platform.mjs';

/**
 * Section name, in the `tool:<tool>` shape the harness's own tool guidance
 * uses. Names are unique within a layer and a duplicate throws, so this one is
 * namespaced by the plugin rather than by the tool alone.
 */
export const PROMPT_SECTION = 'tool:screen-eye';

/**
 * Where the section lands: just after the last first-party tool-guidance
 * section, and before the LSP one.
 *
 * The anchor is read from the prompt registry rather than written as a literal,
 * for the same reason `lib/platform.mjs` is asked which platforms exist: a
 * number copied out of another package is a number that goes stale when that
 * package renumbers. Order values are not unique — sections with equal orders
 * fall back to name order — so the offset only has to stay inside the gap, and
 * the gap is 100 wide on both sides.
 */
const ORDER_OFFSET = 50;

/**
 * The standing line itself.
 *
 * Written to be true wherever it is registered, because it is registered
 * wherever a capture engine exists. The consent sentence is therefore asked of
 * the engine registry rather than written unconditionally: Windows has no grant
 * to report and no `screen_permission` tool, and a standing line that promised
 * one would send the model looking for a tool that is not there. The question
 * is phrased as a pointer to that tool rather than as a statement about this
 * machine, because whether Screen Recording is granted is a live fact and a
 * standing line that asserted it would be wrong from the moment a user changed
 * it.
 *
 * The last sentence is the one that earns its place. It is the difference
 * between a model that plans "ask the user for a screenshot" and one that plans
 * "look": a capture is a normal tool call whose result is a picture, rather
 * than a second step that has to be arranged.
 *
 * @param permission - whether this platform has a consent tool to point at.
 * @returns the sentence, assembled rather than templated: every clause in it is
 *   a fact that holds on the platform it is being registered on.
 */
export function promptSectionText(permission) {
  return [
    'This deployment can see the screen: capture it with the screenshot tool and the picture comes back in that same call, so no read_image step follows.',
    'Reach for it whenever the answer is on screen rather than in a file — checking your own UI work, reading a running app, a dialog, an error, or anything visual you cannot read out of the workspace.',
    'A burst of frames records motion instead.',
    ...(permission
      ? [
        'A capture can need Screen Recording permission; screen_permission reports whether it is granted and opens the pane that grants it.',
      ]
      : []),
  ].join(' ');
}

/**
 * The skill body, for a reader who arrives through the skill catalog rather
 * than through the system prompt.
 *
 * Written as the reference for the workflow, not as a second copy of the tool
 * schema: it says which mode to reach for and why, and it names the two
 * failures worth knowing about in advance — a scaled display, and a missing
 * grant.
 */
export const SKILL_NAME = 'screen-eye';

/** Catalog description. Routing only: the catalog shows this, not the body. */
export const SKILL_DESCRIPTION =
  'See the screen: when to capture, which mode to reach for, and how to read what comes back.';

/** Catalog routing hint, shown beside the description. */
export const SKILL_WHEN_TO_USE =
  'Before answering any question about what is on screen, and before reporting UI work as done.';

/** The skill body. */
export const SKILL_CONTENT = `# Seeing the screen

The \`screenshot\` tool captures the screen and hands back the picture in the same call. There is no separate step to fetch or open the image, and no need to ask the user to describe what they see.

## When it applies

Any question whose answer is on screen rather than on disk:

- Checking your own UI work after building or changing an interface.
- Reading a running application, a dialog, a window, or an error the user is looking at.
- Reading a page, a chart, or a picture the user referred to without attaching it.
- Watching something move: a transition, an animation, a progress bar, a load.

A file the user attached is \`read_image\`'s job. A fresh look at a live screen is this one's.

## Reading a screen takes two passes

An overview — \`mode: "screen"\`, or one display — shows where things are. A region shows what is there, at one image pixel per screen pixel.

The overview is a picture to judge by eye, not a ruler. A coordinate estimated from it lands near the mark rather than on it, which is how a region ends up covering the row above the one intended. The reply names where the region landed, so a second attempt can be aimed rather than guessed; aiming twice beats measuring once.

## Which mode

| Question | Mode |
| --- | --- |
| What is on screen? Which part matters? | \`screen\` |
| Which displays exist, and how are they numbered? | \`displays\` |
| What does this part say, exactly? | \`region\` |
| What is on the second monitor? | \`display\` with \`display: 2\` |
| What does this look like over time? | any mode with \`frames\` above 1 |

Regions are in screen points with the origin at the top-left of the main display, so a display left of or above the main one takes negative coordinates.

## Turning a position in the picture into a screen position

The reply carries the screen position of the capture's own top-left corner, so a position you can see in the picture becomes a screen position by adding, and the scale between the two is the one number that matters:

    scale  = capture width in pixels ÷ the screen points it covers
    screen = screenOrigin + (position in the picture ÷ scale)

That covers both things in one formula. The harness projects every image onto a route-level budget before you see it, so the picture is usually reduced — a full 4K screen arrives around 1066 points wide — and a Retina panel was captured at twice its point size in the first place. Both are just the scale, and the reply's capture dimensions are the ones after any reduction.

Estimating the scale from a known landmark on screen is more reliable than trusting the arithmetic: find something whose real width you know, measure it in the picture, and divide.

## Watching motion

\`frames\`, \`interval_ms\`, and \`duration_ms\` describe one burst; any two of them determine the third. The interval is the cost lever — twice the interval is half the frames for the same span and half the tokens. \`wait_for_change\` starts the burst when the picture moves, which is for a transition that runs once and cannot be triggered on demand.

## When nothing comes back

\`screen_permission\` answers this in one call. On macOS a capture needs Screen Recording permission for the process running the harness, and the tool reports whether it is granted, names the entry to look for, and opens the settings pane that grants it. There is more than one entry to check because the harness can be running as the terminal's child or as the app itself. A grant takes effect without a restart.

Under a sandbox, a capture can also fail because the harness process is not allowed to talk to the window server. The error says which of the two it was; the two have different fixes.`;

/**
 * Register the standing section, declaring the capability while the tools are
 * mounted to back it.
 *
 * The text is a provider rather than a string so that turning the announcement
 * off is a settings edit rather than a restart: the provider is evaluated at
 * each assembly and reads the current value. Registering conditionally instead
 * would have frozen the decision at mount time, when the setting that is
 * supposed to control it cannot have changed yet.
 *
 * @param ctx - a context that has the `systemPrompt` service.
 * @param readSettings - reads the current plugin settings.
 * @returns the exact effect disposer.
 */
export function registerPromptSection(ctx, readSettings) {
  const order = ctx.systemPrompt.getSectionOrder('TOOL_WEB_FETCH') + ORDER_OFFSET;
  // Asked of the engine registry rather than of a platform name, so a second
  // engine that needs no consent cannot leave the sentence behind.
  const text = promptSectionText(platformFor().permission !== null);
  return ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order,
        text: () => (readSettings().announceCapability === false ? '' : text),
      }),
    'screen-eye.systemPrompt.section()',
  );
}

/**
 * Register the skill, if this deployment has a skill registry.
 *
 * Absence is not a failure: a headless or SDK composition can mount the tools
 * without the registry, and the section above already carries the part that
 * matters. A duplicate name is not a failure either — the registry logs it and
 * hands back a no-op disposer, and a project skill of the same name is
 * documented to win — so nothing here may throw at mount.
 *
 * @param ctx - the registration scope.
 * @param log - a named logger.
 * @param enabled - whether the announcement is switched on in the settings as
 *   they stand at mount. A skill registration cannot be walked back, so unlike
 *   the section this one is decided once rather than read per assembly.
 */
export function registerSkill(ctx, log, enabled) {
  if (!enabled) return;
  ctx.inject(['skills'], (skillCtx) => {
    try {
      skillCtx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content: SKILL_CONTENT,
        source: 'runtime',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn('the screen-eye skill could not be registered: %s', detail);
    }
  });
}
