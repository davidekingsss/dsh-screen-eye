# Watching something move

A still capture answers "what is on screen". It cannot answer "what just
happened" — a spinner, an animation, a dialog appearing, a progress bar. This
page records what was tried for that, what the harness actually does with the
obvious answer, and why the tool works the way it does.

## An animated GIF cannot work, and the reason is not the provider

The DeepSeek API accepts GIF as an input format, so "can it read a GIF" looks
like the question. It is not. **By the time an image reaches the provider from
this harness, an animated GIF is already a single frame**, and it was reduced
in the attachment store, before any request was built.

`@deepseek-ai/dsh-attachment-local` normalises every stored image with sharp.
It reads the frame count — `animated: (metadata.pages ?? 1) > 1` — and then
uses that fact for one thing only: forcing the image down the re-encode path,
because GIF is excluded from pass-through outright. The re-encode pipeline is
constructed without `animated: true`, so sharp decodes the first frame; the
encoder ladder has WebP and JPEG as its only outputs and never writes GIF; and
the result is asserted to be single-frame before it is stored.

The fact is not merely dropped at one step, either — it does not exist at the
type level. Neither `ImageAttachmentRef` nor the model-facing `ImageBlock`
carries anything about frames, so no later stage could preserve it even if it
wanted to.

This was verified rather than argued: a real three-frame GIF put through the
package's own exported normalisation and request-projection functions came out
as a single-frame WebP, and again as a single-frame WebP at the request layer.
The model is told it received `image/webp`, which is true and also tells it
nothing about the frames that are missing.

Recording video and converting it is not a way around this either. The obvious
local transcoder on the development machine could not run at all — its
Homebrew build links a version of x265 that is not the one installed — and the
only working `ffmpeg` was one bundled inside an unrelated third-party
application. Depending on that for a plugin's core behaviour is not a
dependency worth having, and it would still end at the same single frame.

## What the tool does instead

`frames` above 1 takes that many captures, spaced by `interval_ms`, and returns
them all in one call as separate images. It is better than a GIF here, not a
substitute for one:

- **Every frame is seen.** The harness projects each image to a route-level
  budget of about 640,000 pixels — measured, not assumed — so six frames arrive
  as six full-detail images rather than as six slivers of one.
- **The frame count is exact.** `screencapture`'s video mode is variable-frame-
  rate: it drops duplicate frames, so a two-second recording of a still screen
  yields six frames, not twenty. Sequential captures yield what was asked for.
- **No transcoder, no intermediate format.** Frames are the same PNG the single
  capture produces, so nothing depends on a third-party binary, and every frame
  keeps the coordinate mapping to the screen that `region` relies on.
- **Full colour.** A GIF's 256-colour palette blurs small text; these do not.

The costs are real and worth stating: each frame is one image, and one image
costs at most 384 vision tokens — measured at about 380 for a full-screen capture
— so the frames are the whole price of a burst. What bounds them is not a count
this plugin invents but the provider's 600 images per request and the size of the
conversation they land in; see "What a burst is allowed to cost" below, which is
also where the ten-frame cap this page used to describe went.

## Using it well

A burst over the whole screen is usually wasted. With the budget being fixed
per image, a region that fills it carries far more than a region seen inside a
full-screen capture — measured at a factor of **3.3 in linear detail for the
same token cost**. So the useful shape is "watch *this* area for a second"
rather than "watch everything":

```
screenshot  mode=region  region=<the area>  frames=6  interval_ms=200
```

## How fast frames can be taken

`interval_ms` is a target rather than a promise, and how low it can go depends
on how much of the screen is being encoded. Measured on the development
machine, five runs each:

| captured area | per frame | frames across a 300-500ms animation |
| --- | --- | --- |
| 3840x2160, whole screen | 155 ms | 1-3 |
| 1920x1080 | 71 ms | 4-7 |
| 1200x800, a component | 56 ms | 5-8 |
| 600x400 | 51 ms | 5-9 |
| 200x150 | 47 ms | 6-10 |

Roughly two thirds of the cost is process startup and one third is encoding,
which is why the curve flattens: the floor is about 45ms whatever the area.

These are **main-display figures**, measured through the HDMI path on a 4K
monitor. A second screen can differ: an iPad in Sidecar took 189ms for a full
capture of 2388x1668, slower than the larger 3840x2160 main screen at 169ms,
because the transport is not the same. Region captures were within a
millisecond of each other on both.

## The same question on Windows, and a different answer

The table above is the macOS profile, where the fixed cost is small and the area
is what costs. Windows inverts it. Measured on a 3840x2160 machine, with the C#
shim already cached:

| | cost |
| --- | --- |
| `powershell.exe` start alone | 148ms, once per engine call |
| loading the compiled shim | 24ms, once per engine call |
| a frame at 3840x2160 | ~155ms — the same as macOS |
| a frame at 1300x600 | ~22ms |
| a frame at 400x300 | ~11ms |
| a complete single capture | ~380ms, whatever the area |

So the interval is not bounded by the area at all; it is bounded by the process
start, and a burst taken as N calls would pay it N times — six frames of a 400ms
animation sampled over two and a half seconds, which is not a sample of it.
Windows therefore takes the whole burst in **one** engine call: one process, one
shim, one rectangle, N frames spaced by the interval. Inside that loop a frame
costs what the area costs, and it costs less than on macOS, because macOS pays
its ~45ms of process start per frame:

| captured area | Windows, in a burst | macOS, per frame |
| --- | --- | --- |
| 3840x2160, whole screen | 161ms | 155ms |
| 1920x1080 | 60ms | 71ms |
| 1200x800, a component | 29ms | 56ms |
| 600x400 | 13ms | 51ms |
| 200x150 | 12ms | 47ms |

Those macOS figures are the ones this page carried as estimates. They were
measured on a 3840x2160 panel on 2026-09-16 and hold: a 1920x1080 frame is
**67.9ms**, a 1200x800 one **55.8ms** and a 400x300 one **47.7ms**, which is the
same shape — a fixed cost of about 45ms plus the encoding. What the same run also
measured is macOS's resident helper, which removes the fixed cost: the same
frames come back in **29.2ms**, **18.4ms** and **13.2ms**. So the "macOS pays its
~45ms of process start per frame" sentence above is a statement about
`screencapture`, not about the platform, and a warm macOS is closer to Windows in
a burst than this table shows. `docs/macos-findings.md` has the full set.

### The interval floor, asked for and achieved

`interval_ms` is a target, and what a burst achieves is `max(target, frame cost)`
plus a dozen milliseconds of scheduling. Asked for against achieved, ten frames
each:

| asked | 1300x600 (frame cost 22ms) | 400x300 (11ms) | 3840x2160 (155ms) |
| --- | --- | --- | --- |
| 10ms | 23ms | 19ms | 159ms |
| 20ms | 34ms | 33ms | 160ms |
| 40ms | 48ms | 48ms | 160ms |
| 80ms | 94ms | 93ms | 155ms |
| 160ms | 173ms | 172ms | 178ms |

The floor is the frame cost, which is the same rule macOS follows — and on a
region it is **19-23ms against macOS's 47ms**. At full screen the two platforms
land on the same number to the millisecond, because there the cost is the
encoder and not the process.

### What that means for a 300ms animation

Measured against an animation whose truth is known exactly: a 60px block
crossing 660px in 300ms, repeating every 700ms, captured through the engine and
then recovered from the frames' own pixels.

- **Region, 1300x600, `frames: 10, interval_ms: 40`** — achieved 48ms, the block
  found in **10 of 10 frames**, six of them inside the movement, positions
  advancing 285 → 413 → 542 → 675 → 807 → 938. The speed recovered from the
  frames is 2207-2787 px/s against a true 2200 px/s, and one burst covers up to
  750 of the 660 px the block travels. That is enough to say what the animation
  does: direction, distance, duration and easing shape are all visible.
- **Full screen 4K, `frames: 6, interval_ms: 170`** — achieved 184ms, one frame
  inside the movement. Enough to know *that* something moved, not enough to say
  how.

Which is the advice the macOS section already gives, now with a Windows number
behind it: **capture the region the motion happens in**. A component-sized
region resolves a 300ms transition on Windows at least as well as macOS does,
and better at the small end.

### The one place Windows is worse: getting started

A burst cannot take its first frame before its engine exists. On macOS the first
frame lands 50-155ms after the call; on Windows it lands ~380ms after it, which
is PowerShell starting, the shim loading and WinForms coming up.

So Windows now keeps an engine resident instead. It is started on the first
capture, preloads everything, and then answers in **16-22ms** — which turns the
table below from "zero frames" into "the whole animation".

## Waiting for the animation instead of racing it

Everything above measures a burst against a screen that is *already* moving —
which is why the first version of this page could be satisfied by a looping
animation. A component animation does not loop. It plays once, when the user
does something, and the arithmetic of catching it is unforgiving:

| when the call is issued | Windows before | Windows with a resident engine | macOS (region) |
| --- | --- | --- | --- |
| at the instant it starts | 0 frames | 10 frames | 6 frames |
| 100ms after | 0 frames | 9 frames | 4 frames |
| 300ms after | 0 frames | 0 frames | 0 frames |

The middle column is the point. **No amount of start-up speed fixes the last
row**, because the delay there is not the plugin's: a model has to notice, decide
and get a tool call scheduled, and that is hundreds of milliseconds at best and
usually seconds. A plugin cannot outrun a decision, and it should not pretend
the animation is waiting for it.

So the burst stops racing and starts waiting. `wait_for_change: true` means:
watch this rectangle, do nothing while it is still, and take the frames from the
moment it moves. The caller issues the call *before* the user triggers anything,
which is the one thing the model is actually good at:

```
screenshot  mode=region  region=<the component>  interval_ms=35  wait_for_change=true
```

No frame count: with the ending left to the screen there is nothing to size, and
the cap is only what happens if the motion never stops.

The animation's own start becomes the cue, so alignment stops depending on the
network or on how fast a model is. Measured on a known 300ms transition,
triggered six seconds after the call was issued:

```
change detected 103ms after the trigger; 8 frames at 47ms spacing
  + 103ms  x= 509   <- inside the movement
  + 151ms  x= 638
  + 196ms  x= 771
  + 244ms  x= 899
  + 291ms  x=1032
  + 339ms  x=1037  (the transition has finished)
frames inside the 300ms movement: 4-5 of 8
```

Four to five frames of a 300ms transition, with the position advancing
monotonically through them: enough to read direction, distance, duration and
easing. The 103ms is two poll intervals plus the engine's own round trip — the
detection has to see a change twice before it believes it, and that confirmation
is worth the 20ms it costs.

**A change is not "any difference".** The first version of this fired 461ms into
a call that was watching a completely still screen, because a cursor blinked
inside the rectangle. What the engine compares is a few thousand sampled pixels,
and what the wait asks is *how many* of them moved: a quarter of a percent, held
for two consecutive checks. A 60px block crossing a 1300x600 region moves about
0.8% of the points; a cursor is worth about 0.1%. The threshold sits between them
because that is the only place it can sit.

macOS has the same wait, and it used to be the weaker one: with no helper to ask,
each check ran `screencapture` and compared the bytes with their descriptive
chunks stripped — 47ms for a component-sized region against the engine's 18ms —
and it could only answer "something moved", which is why the confirmation count
exists. That was measured on 2026-09-16 and the arithmetic did **not** work out.
A check on a component-sized region costs 56-90ms per poll cycle rather than 47ms,
and a change must be confirmed twice, so a burst watching a 300ms transition
recorded its **last third**: of 373px of travel the returned frames covered
24-98px, which is one or two motion frames out of five or six captured. The
earlier claim here — that this "leaves four or five frames of a 300ms transition"
— assumed the confirmation and the first frame were free. Both cost a full check.

So macOS has a resident helper too, for exactly the reason Windows does. Apple
obsoleted `CGDisplayCreateImage` in macOS 15, so ScreenCaptureKit is the only
supported route to the screen and it needs a compiled program; the helper is built
from source on the user's machine on first use and inherits the harness's Screen
Recording grant, so it costs no second prompt. Resident, a change check is
**22.6ms** and a 400x300 frame **13.2ms** against 47.7ms, and the same watched
transition is covered over **270-348px** instead of 24-98px. `screencapture`
remains the engine of record and every failure except a denial falls back to it.
`docs/macos-findings.md` has the measurements.

The wait gives up rather than guessing. If nothing moves for `wait_timeout_ms`
(thirty seconds by default, because the user has to read that something is
watching and then trigger it) the call **fails and says so**, because a burst of
a screen that never changed is not a weaker answer, it is a wrong one.

### Where to watch

What the burst watches is the rectangle the frames come from, so the caller
chooses it, and the choice is a trade rather than a rule. The engine compares a
few thousand sampled points, which fixes how much of the rectangle each point
speaks for:

| watching | good at | bad at |
| --- | --- | --- |
| a component | a small animation changes a large share of the points, so it is seen, and little else in the rectangle moves | missing a transition that happens somewhere else |
| the whole screen | anything that moves anywhere — a page load, a video, a full-screen app, a desktop-wide rearrange | a small animation spread thin across the samples, and any unrelated movement starting the burst first |

Both are legitimate. Whole-screen watching is the right answer when everything
is expected to move and the wrong one when only one part should, and it is the
caller's to judge — the parameter description says exactly that rather than
forbidding it. What it cannot be is a substitute for looking: a region read off
an earlier capture — and a region is in the same coordinates as the full capture,
verified by comparing one against the matching crop of a 4K capture pixel for
pixel — is what makes a small animation visible at all.

What the wait deliberately does **not** do:

- **It does not separate the watched rectangle from the captured one.** One
  rectangle serves both: two would mean two coordinate systems inside one call
  and a second thing to get wrong.
- **It cannot see a transition shorter than about 100ms.** A change has to be
  confirmed twice before the burst starts — 103ms measured end to end — so a
  transition that begins and ends inside that window is over before the first
  frame. That is the price of not firing on a cursor blink, and it is why the
  parameter description tells the model to capture directly and compare frames
  for anything that short.
- **It fires on the first change it believes in** — the first, not the most
  interesting. If something else moves inside the rectangle first, that is what
  gets captured.

### The frames arrive as one batch, and that is the point

The wait happens inside the call, and the call returns when it is done: the
whole set of frames, in order, with their spacing. It is not a stream, and it
should not be — a sequence only means something as a sequence. One frame pushed
at a time would tell a model nothing about what it was watching, and the
question "what did this transition do" cannot be answered from a frame that
arrived before the previous one was understood. So the burst runs to completion
and hands over the set, which is also why `wait_timeout_ms` has to cover
everything that happens before the animation starts: the user has to read the
message asking them to trigger it, and then trigger it.

Each frame also comes back with its path, so the model can re-read or crop one
of them later without asking for the burst again.

## When the burst ends, and why the frame count cannot say it

Everything above settles when a burst *starts*. The harder half is when it
stops, and the frame count is the wrong instrument for it. A caller who asks for
eight frames of a 300ms transition gets three that show the motion and five that
show a screen that has stopped: most of the answer is spent on nothing. A caller
who asks for three frames of a 900ms transition gets a third of it. Both callers
picked their number for the same reason — it was the only number available — and
neither could have known better, because the length of the motion is exactly
what they were calling to find out.

The only thing that knows when the motion ends is the screen. So the burst keeps
looking at what it is capturing and ends when the picture settles: two
consecutive still frames, which is a threshold rather than a formality, because a
transition can hold still in the middle — an eased step, a pause between two
phases — and a single still frame would end the recording right there.

**This is implied, not asked for.** A burst that waited for a change is a
recording of that change; the change ending is where the recording ends. Making
the caller request it would put the burden back on the one party who cannot know
whether it is needed, so the rule is: `wait_for_change` plus more than one frame
means the screen decides the ending. There is nothing to remember.

`frames` becomes an **upper bound and a safety net**. While the motion lasts,
nothing clamps it: the frames taken are the ones the motion spans. Once the
motion has stopped, the ending clamps the call immediately rather than letting it
run out a number somebody guessed. The cap is what happens if the picture never
settles — a spinner, a video, a screen with a clock on it — and it still costs
the same ten images it always did, which is why it stays.

That changes what it costs to ask for headroom, and the planner follows:
a caller who gives an interval and no frame count gets the ten-frame cap rather
than the ordinary six. Asking for ten costs nothing when the transition ends the
burst at five, and it is the difference between catching a 700ms animation and
missing its second half. A caller who named a frame count or a window has already
answered the question and is left alone.

Measured, on the same known 300ms transition used above, with nothing but
`interval_ms: 40` and `wait_for_change: true` — no ending parameter at all:

| run | frames | spacing | ended because | block x, in order |
| --- | --- | --- | --- | --- |
| the transition, then 2.5s of stillness | 7 | 56ms | the picture settled | 553 → 638 → 812 → 982 → 1037, 1037, 1037 |
| the same call with `until_still: false` | 10 | 47ms | the frame limit | 10 identical frames |

The first row is the whole design: four frames reading the motion, then three
that say it has stopped, and the burst ends itself at 2.6s instead of taking the
six frames it still had left. The second is the other job — a caller who wants a
span recorded rather than an event, and says so — and there the frames are taken
to the end of the window whether or not anything moved in them.

The reply always says which ending happened, in the structured field
(`endedBecause: "still" | "frames"`) and in a sentence, because the two call for
opposite next steps. "The picture stopped changing after 7 frames, so the burst
ended there: these frames cover the motion from where it started to where it
settled" is a finished answer. "The picture was still changing when the 10-frame
limit ran out, so this recording stops in the middle of the motion" is an
unfinished one, and it names the fix: a smaller region, where the frames come
faster and the same cap covers more of the animation. A burst that was not
watching for a stop says neither, because there is nothing to explain.

### Waiting and capturing draw on one budget

The wait is dead time by construction — it exists for a transition nobody has
triggered yet — so it and the capture that follows it share one budget rather
than each holding a copy. `timeout_ms` (five minutes by default) covers the whole
call, and the capture is given what the wait did not spend. A wait that could eat
a capture would turn "watch this animation" into "return nothing", which is why
the default leaves room for the worst case the tool advertises: a 30s wait for
the trigger, and then a burst that may legitimately run for minutes under
`until_still` with a long interval.

## What a burst is allowed to cost, and who decides

The first version of this plugin capped a burst at ten frames, on the reasoning
that the harness allows twenty images per message and a burst should leave room
for the rest of the conversation. **The reasoning was wrong, and the cap was this
plugin's own opinion rather than anybody's limit.** Checked against the
deployment's code:

| limit | value | enforced by | what happens at it |
| --- | --- | --- | --- |
| images in one provider request | 600 | `dsh-llm-deepseek` (`maxImagesPerRequest`) | the excess is replaced with a text placeholder — the frames are taken and then not seen |
| images in one attachment batch | 20 | `dsh-attachment` (`saveImages`) | the batch is refused |
| aggregate bytes in one batch | 200MB | `dsh-attachment` | the batch is refused |
| one image's side / pixels / bytes | 8192 / 64M / 20MB | attachment store | that image is refused |
| vision tokens per image | 384 | the provider's own accounting | — |

The twenty is a *batch* limit, and this plugin saves one image per call
(`saveImage`, not `saveImages`), so it never applied here at all. The real
ceiling is the provider's **600 images per request**, and the real cost is 384
vision tokens per image at most — measured at about 380 for a full-screen
capture, because the adapter projects every image to a 640,000-pixel budget
whatever the capture's size.

So the cap is now the provider's 600, and the decision moved to where the
information is. A plugin cannot see the conversation a burst will land in; the
model can. Ten frames is about 4k tokens and sixty is about 23k, and which of
those is worth spending on a particular animation is not a question with a
platform-independent answer. What the tool does instead of deciding is **say the
arithmetic in its own description** and report what was taken.

That leaves one place where a count still decides something, and it is worth
being precise about which: when the picture settles the ending, the count is
headroom and the caller's silence about it is filled with `STILL_HEADROOM_FRAMES`
— sixty, which is twelve seconds at a 200ms interval and sixty at a second apart.
Sixty rather than six hundred because the cap only ever gets spent in one case: a
picture that never settles. There the ending never comes, the headroom is what
gets taken, and sixty frames is 23k tokens where six hundred would be
conversation-ending. A caller that wants more samples of something endless can
name a count — the ceiling is the provider's, not this plugin's.

### The interval is the lever, not the window

A burst is `frames`, `interval_ms` and `duration_ms`, any two of which determine
the third — and of the three, the one that decides how much is spent and how well
the motion is read is **`interval_ms`**. Halving it doubles the frames for the
same span at double the token cost; doubling it is the reverse. `duration_ms` is
a convenience for when the window is the thing the caller knows, and it is
documented as *not* the way to size a burst, because a caller who reaches for it
is thinking about the span rather than the sampling, which is the wrong way round
for both cost and resolution.

Nothing in the tool imposes a duration. The burst length is
`(frames - 1) x interval_ms`, the ending is the picture's when the call waited,
and the call's only fixed quantity is the budget it may not exceed — `timeout_ms`,
which is the caller's to set up to the ceiling the tool declares to the harness.

## Three numbers, any two of which settle the third

A burst is described by how many frames, how far apart, and over how long. The
frames span `(frames - 1) x interval_ms` of real time, so the ordinary six at
200ms cover about a second — right for a one-second process, wrong for a 300ms
animation and equally wrong for a two-second one. Leaving that arithmetic to the
caller is how it gets got wrong.

So all three are parameters, and **any two determine the third**:

| given | settled |
| --- | --- |
| `frames` + `interval_ms` | the span |
| `frames` + `duration_ms` | the interval that divides the window |
| `interval_ms` + `duration_ms` | how many frames fit |
| `duration_ms` alone | the ordinary frame count, at an interval that divides the window |

The second row is the one that matters for cost. Holding the window fixed and
raising the interval is how a caller asks for a **coarser sample rather than a
shorter one** — the same motion, watched with fewer images. Since each frame is
an image and images are what cost, that is the lever — and it is why the tool's
own descriptions lead with `interval_ms` and describe `duration_ms` as a
convenience for when the window is what you know, rather than as the way to size
a burst.

Giving all three is refused rather than resolved: a caller who set all three has
a belief about which wins, and guessing wrong is worse than saying so.

A window given alone is sampled at the ordinary frame count rather than at the
maximum, because the maximum is the most expensive answer and was not asked for
— unless the call is waiting for a change first, where the ending is the screen's
to decide and the count is headroom rather than a plan.

That also defines the reachable range. The lower bound is the capture cost: ten
frames at the 47ms floor spans about 0.4s, and no request can resolve motion
shorter than that. The upper bound is the interval times the count, and the count
now runs to the provider's own 600, so the reachable span is wide enough that
duration stops being the constraint at all: 600 frames a second apart is ten
minutes, and 600 frames ten seconds apart is most of a day. What remains the
constraint is sampling *resolution* — how much of the motion a given number of
images can describe — and that is what `interval_ms` sets.

The consequence below is the useful part for resolution. A short animation — a few hundred
milliseconds — is not resolved by asking for a finer interval over the whole
screen, because that cannot be met. It is resolved by **capturing the small
region it happens in**, where the floor is three times lower. The envelope
reports the spacing achieved, and says so explicitly when the request could not
be met, so the next call can ask for something achievable.
