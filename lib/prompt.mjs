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
 * text: what the capability is, which of the two channels a given fact belongs
 * to, and the two properties that change planning — the image arrives in this
 * call, so looking is one step rather than two, and an interface too small or
 * covered to read is a reason to change the view rather than a reason to go
 * looking somewhere else.
 *
 * That last part came from a second measurement, in another deployment and
 * another plugin's territory, and it is the more valuable half. A session asked
 * what video the user was watching answered correctly after sixteen shell
 * commands into a media app's cache database and two web API calls, to recover
 * a title printed in the window's own title bar. The capability was never the
 * problem there — the model had the tools and used one of them. The problem was
 * that nothing had framed "the interface in front of you" as a place where
 * answers live, so it went to the places its habits know: files, caches, APIs.
 *
 * The skill repeats all of it for a reader who arrives through the skill
 * catalog instead, and adds what a standing line has no room for: why a cache
 * is the wrong route for something already displayed, which mode to reach for,
 * what a scaled display does to coordinates, and how to get unstuck when the
 * grant is missing. It is registered at runtime rather than shipped as a file,
 * so installing the plugin is the whole installation — no copy into a skills
 * directory, and nothing on disk that can drift from the code that describes
 * it.
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
 * The first two sentences are the ones that earn their place, and the second
 * was added after a measured session went wrong without it. That session was
 * asked what video the user was watching, and it answered correctly and
 * expensively: sixteen shell commands into an application's cache database and
 * two calls to a web API, to recover a title that was printed in the window it
 * had already looked at. Nothing in the prompt had said that a running
 * interface is a place where answers live; the line said "on screen rather than
 * in a file", and the model read that as "in a picture", never as "in the app".
 *
 * So the split is now stated rather than left to judgement. Interface text and
 * pixels are different channels with different tools, and a window title is
 * text: it is readable, not something to be recognised from a picture. The
 * third sentence exists for the same reason — a target too small or too
 * collapsed to read is a reason to change the view, and the measured session
 * reached for a cache dump instead because nothing had framed it as one.
 *
 * @param permission - whether this platform has a consent tool to point at.
 * @returns the sentence, assembled rather than templated: every clause in it is
 *   a fact that holds on the platform it is being registered on.
 */
export function promptSectionText(permission) {
  return [
    'This deployment can see the screen, and seeing is a way of finding things out rather than a last resort: when the answer is on screen rather than in a file, look instead of searching.',
    'Read text out of a running app\'s interface — a window title, a field value, a dialog, a message — by observing that app, whose accessibility tree hands it over as text; keep the screenshot tool for visual facts with no text to read, such as layout, colour, motion, and anything you are judging by eye.',
    'A window too small, collapsed, or covered to answer from is a reason to expand it, scroll it, or move it back into view, and then look — not a reason to go looking for the same information in caches, databases, files, or APIs.',
    'The screenshot tool captures and returns the picture in that same call, so no read_image step follows, and a burst of frames records motion instead.',
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
 * schema: which channel to read for which fact, what to do when the view itself
 * is the obstacle, and the two failures worth knowing about in advance — a
 * scaled display, and a missing grant.
 */
export const SKILL_NAME = 'screen-eye';

/** Catalog description. Routing only: the catalog shows this, not the body. */
export const SKILL_DESCRIPTION =
  'See the screen: when to look instead of searching, when to read an interface versus a capture, and how to read what comes back.';

/** Catalog routing hint, shown beside the description. */
export const SKILL_WHEN_TO_USE =
  'Before answering any question about what is on screen, before looking for on-screen information in caches, files, databases or APIs, and before reporting UI work as done.';

/** The skill body. */
export const SKILL_CONTENT = `# Seeing the screen

The \`screenshot\` tool captures the screen and hands back the picture in the same call. There is no separate step to fetch or open the image, and no need to ask the user to describe what they see.

## Looking is a way to find things out

The habit worth breaking: reaching for a cache, a database, a log, or a web API when the answer is already displayed in front of the user. Those routes are for facts with no interface. When something is on screen — a title, a list, a panel, a dialog, a comment thread — the interface is the source, and it is the source that stays correct when the app changes its storage format.

This matters most as a fallback. Memory caches go stale, private APIs need keys, local databases need a schema you have to reverse-engineer, and an app that renders content server-side may keep none of it on disk. A window that is open on the user's screen has none of those problems.

## Text from the interface, or a picture of it

Two different channels, two different tools, and picking the wrong one is what makes an answer expensive:

- **Interface text** — a window title, a field value, a button, a message, an error, a list row — comes from **observing the app** (the computer-use capability's Accessibility tree). It arrives as text: exact, greppable, and free of recognition error. When what you want is characters, read them rather than recognising them.
- **Pixels** — layout, colour, spacing, an icon, a chart's shape, whether something looks right — come from the **\`screenshot\` tool**. There is no text to read, so the picture *is* the evidence.

A measured session got this backwards and paid for it. Asked what video the user was watching, it ran sixteen shell commands into a media app's cache database and two web API calls to recover a title that was printed in the window's own title bar — a string it could have read in one observation. The information was not hidden; the route to it was wrong.

## When the view is the obstacle, change the view

A picture-in-picture window, a collapsed panel, a list below the fold, an app behind another window: these are reasons to *operate the interface*, not reasons to go looking for the same data elsewhere. Move the window back into view, expand the panel, scroll the list, open the tab — an action that produces no information of its own, taken so that the next look can answer.

That step is easy to skip because it feels like it is not "getting data". It is getting data; it is making the data visible.

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
