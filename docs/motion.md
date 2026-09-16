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

The costs are real and worth stating: each frame is one image against the
harness's 20-images-per-message budget, which is why a burst is capped at ten,
and each frame costs what a capture costs, about 380 tokens.

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
screenshot  mode=region  region=<the component>  frames=8  interval_ms=35  wait_for_change=true
```

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

macOS has the same wait, with a weaker instrument. It has no resident helper to
ask, so each check runs `screencapture` and compares the bytes with their
descriptive chunks stripped — 47ms for a component-sized region against the
engine's 18ms — and it can only answer "something moved", which is why the
confirmation count exists. The maths still works out: a 47ms check plus one
confirmation puts the first frame inside 150ms of the change, leaving four or
five frames of a 300ms transition. Without the wait, macOS is in the same
position as Windows: a call issued 300ms late gets nothing.

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
an image and images are what cost, that is the lever.

Giving all three is refused rather than resolved: a caller who set all three has
a belief about which wins, and guessing wrong is worse than saying so.

A window given alone is sampled at the ordinary frame count rather than at the
maximum, because the maximum is the most expensive answer and was not asked
for.

That also defines the reachable range. The lower bound is the capture cost: ten
frames at the 47ms floor spans about 0.4s, and no request can resolve motion
shorter than that. The upper bound is only the interval, so ten frames a second
apart spans nine seconds and ten frames ten seconds apart spans a minute and a
half. Between those, any window is expressible — the constraint is sampling
*resolution*, not duration.

The consequence below is the useful part for resolution. A short animation — a few hundred
milliseconds — is not resolved by asking for a finer interval over the whole
screen, because that cannot be met. It is resolved by **capturing the small
region it happens in**, where the floor is three times lower. The envelope
reports the spacing achieved, and says so explicitly when the request could not
be met, so the next call can ask for something achievable.
