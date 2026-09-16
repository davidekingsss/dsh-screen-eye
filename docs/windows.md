# Windows

Windows is served. It was the obvious next platform, and it is now the second
implementation behind the seam: `lib/platform/win32.mjs`, selected by
`process.platform`, with the tool layer unchanged.

What follows is what the port actually does, what differs from macOS and why,
and which parts of it were run on a real machine rather than reasoned about.
The short version of that last point: the engine was developed **on** Windows,
so unlike a port written from macOS, its numbers and its failure modes are
observations. The parts that remain unverified are named at the end.

## What is platform-specific, and what is not

The plugin is a platform-neutral core with an operating-system layer behind a
seam. Everything that depends on the system is reachable through exactly one
module, `lib/platform.mjs`, which selects an implementation by
`process.platform`. The tool layer imports that and nothing else — a self-test
case walks the real import graph and fails if any OS-specific module becomes
reachable from outside the seam, because a seam survives exactly until the next
convenient shortcut.

| member | macOS | Windows |
| --- | --- | --- |
| `capture(plan, outputPath, options)` | `screencapture` and its flags | PowerShell driving `System.Drawing` |
| `captureBurst(plan, options)` | — (the generic loop) | one PowerShell process for the whole burst |
| `listDisplays(options)` | `system_profiler SPDisplaysDataType` | `Screen.AllScreens` |
| `permission` | the Screen Recording consent model | `null` |
| `briefing` | what the model must be told about macOS | what it must be told about Windows |
| `interactiveModes` | `window`, `select` | `select` |

## The engine, and why it is PowerShell

The macOS engine shells out to `screencapture` because the alternative is a
compiled artefact. Windows has no equivalent command-line capture tool —
Snipping Tool is an interactive application that hands its result to the
clipboard — so the engine is Windows PowerShell 5.1, present on every Windows
install, driving `System.Drawing` through a shim compiled in memory by
`Add-Type`. Nothing is shipped as a binary and nothing is installed.

`powershell.exe` rather than `pwsh`: 5.1 is the one that is always there, and
it is STA by default, which is what the WinForms screen enumeration wants. The
script is handed over as `-EncodedCommand` (base64 of UTF-16LE), so no path, no
C# block and no here-string has to survive a trip through `cmd`-style quoting
rules. It prints one marked JSON line; the marker is what makes the reply
parseable even when PowerShell decides to say something else on stdout.

### DPI, which is not a detail

A DPI-unaware process does not capture the screen it is looking at. GDI
virtualises its coordinates, and `CopyFromScreen` returns a **downscaled bitmap**
of the desktop rather than the desktop. Measured on the machine this was
written on — a 3840x2160 panel at 125% scaling:

```
before SetProcessDpiAwarenessContext:  desktop 3072x1728   (and so is the capture)
after  SetProcessDpiAwarenessContext:  desktop 3840x2160   (its true resolution)
```

Windows PowerShell is DPI-unaware by default, so the shim declares per-monitor-v2
awareness before WinForms is loaded — the order matters, because
`Screen.AllScreens` caches on first touch. For a tool whose purpose is reading
text off the screen, a 25% downscale is not a rounding error; it is the product.
The self-test asserts the order of those two statements in the generated script,
because the failure is invisible in the output: a scaled capture looks like a
correct capture.

### Modes

The four unattended modes map cleanly onto the coordinates the tool already
documents, because Windows addresses displays in virtual-screen coordinates with
the primary display's top-left at the origin and displays to the left of or
above it at negative coordinates — which is exactly the model `region` is
defined in.

| mode | what happens |
| --- | --- |
| `screen` | the primary display's rectangle, which is what macOS's default captures too |
| `display` | the display the inventory numbered `n`, main first, 1-based |
| `region` | that rectangle, refused by name when it overlaps no display at all |
| `displays` | the inventory, with each display's origin, since that is what makes a region on a second screen expressible |
| `window` | the window in the foreground, **as it appears on screen** — anything overlapping it is included |
| `select` | refused, with the remedy in the message |

Two of those are design decisions rather than translations.

**`window` is not interactive here.** macOS waits for the user to click a
window; Windows ships no such affordance, so the mode means the window the user
is actually looking at. It is clamped to the desktop, because a maximised window
reports a rectangle about eight pixels larger than the screen on every side —
its invisible resize border — and capturing beyond the desktop yields black
edges. Observed on a maximised window: `-9,-9 3858x2118` clamped to
`3840x2109`, the missing 51 rows being the taskbar. Because nobody is being
waited for, a `window` burst is allowed here, and the rectangle is resolved once
before the loop so every frame covers the same window; `interactiveModes` is the
platform fact that says which modes still wait, and planning reads it instead of
assuming macOS's answer.

**`select` is refused.** The Snipping Tool overlay is a separate interactive
application that hands its result to the clipboard; there is nothing for a
program to lean on. A mode that silently captured something else would be worse
than one that says it is not available and points at `region`.

### `include_cursor` is composited by hand

`CopyFromScreen` reads the desktop's pixels and never includes the cursor, so a
capture that claims to show where the mouse is has to draw it — after the copy,
or the copy paints over it. The shim calls `GetCursorInfo` and `DrawIconEx`, and
the engine reports what came back: `0` is the draw succeeding, `-2` is a pointer
Windows says is not showing, and anything lower becomes a note on the result.

## There is no equivalent permission gate

macOS gates screen capture behind a user-granted, per-responsible-process
consent, and denies silently when it cannot attribute the request. Windows has
nothing corresponding to that: `CopyFromScreen` against the desktop device
context needs no consent, no prompt and no entitlement.

So `permission` is `null`, and a platform that declares it registers no
`screen_permission` tool — there would be nothing for it to report, and offering
the model a question with no answer is worse than not offering it. That is the
one place where the two platforms' tool surfaces legitimately differ.

One consequence is worth stating plainly, because it is a cost rather than a
feature: on macOS, `screen_permission` is also the channel through which a
failed tool registration becomes visible to the agent (the harness does not echo
plugin logs). On Windows there is no such channel, so a `screenshot` tool that
failed to register because another plugin owns the name would be visible only as
a missing tool. The alternative — registering a permission tool that has no
permission to report — was judged worse.

## The hazard: a confident picture of nothing

A Windows process that is not attached to the interactive session cannot capture
it. `CopyFromScreen` does not fail there; it returns **black**. The naive engine
therefore reports a successful capture of a black screen, and the model is handed
a picture of nothing with no way to tell that from a user whose desktop really
is black.

The port answers that in two places, because the two causes are different:

1. **Before capturing**, the engine checks the window station and the session.
   A process on a station other than `WinSta0`, or in session 0, has no visible
   desktop to read, and it is refused by name with the session it is in and what
   to do about it. This covers the case the documentation predicted: a harness
   run as a service or under a different session. It was verified positively —
   the machine this was written on reports `WinSta0` in session 1 and captures —
   and the negative branch is the Windows API's own definition rather than a
   heuristic.
2. **After capturing**, the frame is sampled (about 30,000 pixels, whatever the
   frame's size) and a frame that is black everywhere is returned **with a note**
   rather than withheld: the image is what the screen really shows, and the note
   is what makes it interpretable. Withholding it would be the plugin deciding
   it knows better than the user; saying nothing would be the failure above.

That covers a locked session, a sleeping or disconnected display, and a
full-screen black window — none of which the preflight can distinguish from a
working desktop. The note also fires for a rectangle that overlaps the desktop
by a sliver, which is how the positive branch is covered by a live case: it is
the only way to produce an all-black frame deliberately on a machine whose
session is in use.

## What one capture costs, and why a burst is one process

Measured on the 3840x2160 machine:

| | cost |
| --- | --- |
| PowerShell start, `Add-Type`, assemblies | ~600ms, once per engine call |
| a frame at full screen (3840x2160) | ~150ms (63-82ms to read, 80-86ms to encode) |
| a frame at 800x600 | ~16ms |
| a complete single capture | 0.5s on an idle machine, 1.0-1.5s with other work running |
| the display inventory | ~460ms |

So a single capture costs about a second whatever it captures, and the area
barely matters. That is the opposite of the macOS profile, where a capture is
45ms of process start against 155ms of encoding a 4K screen — and it has one
consequence worth designing for rather than documenting away.

`lib/capture.mjs` drives a burst frame by frame, which is the contract's
baseline and the right shape on macOS. On Windows it would pay that second per
frame: a 400ms animation would be sampled over six seconds, which is not a
sample of it. So Windows implements the optional `captureBurst` and takes the
whole burst in one engine call — one process, one shim, one rectangle, N frames
spaced by the plan's interval. A six-frame burst of an 800x600 region costs
about 0.7s instead of 6s, and the interval the tool advertises becomes
reachable. The self-test asserts the spacing stays under 700ms on Windows, which
a per-frame process could not do.

Inside that loop a frame costs what the area costs, and the figures land beside
macOS's rather than behind them — 161ms for a 4K frame against macOS's 155ms,
and 12-29ms for the small regions against 47-56ms, because macOS pays its ~45ms
of process start per frame while a Windows burst pays the PowerShell start once.
`docs/verification.md` has the full table next to the macOS numbers.

## What was measured, and what was not

Run on one Windows machine — 3840x2160 at 125%, one display, session 1 — while
writing this:

- every mode: `screen`, `display 1`, `region`, `window`, and the refusals for
  `display 99`, `select`, and a region off the desktop;
- a real burst through the tool, with the spacing actually achieved;
- the inventory, and `display: 1` captured through the index it handed out;
- the black-frame note, end to end, on a frame that is black by construction;
- the captured PNG's own metadata: `sharp` reports it as 8-bit sRGB with no
  profile and no retained metadata, which is the attachment store's
  `canPassThroughNormalization` condition — so the capture is stored as written
  rather than converted at admission. macOS needs its descriptive chunks
  stripped to reach that state; Windows PNGs carry none, so the stripping is a
  no-op there. What the *route* then projects for the model is the harness's own
  step and is the same on both platforms;
- the plugin through the **official loader**: an isolated profile with this
  checkout linked in, the gate composed and open, an agent that found the tool
  from its description alone and called it, the image-capability guard refusing
  a route declared text-only with the model named, and — with the guard lifted —
  a 3840x2160 capture committed to the attachment store and written to the
  configured directory;
- **the whole loop, with a model that can see.** An agent turn was asked for the
  taskbar clock; it reported `clock 10:35` beside the capture's own
  `captured_at 2026-09-16T02:35:12.259Z`, and this machine is UTC+8, so the two
  agree — a reading that can be checked against the timestamp rather than
  believed. It cropped the capture itself before answering, which is the zoom
  workflow;
- **in the everyday profile, after a restart**: the tool mounted, the inventory
  came back with the display origin, the desktop arrived at the route's
  projection of a native 4K capture with the UI legible, an 860x1340 region came
  back as a PNG with **no downscale at all** and every sidebar label readable,
  `include_cursor` put the pointer in the picture, and a three-frame burst
  returned three images in one call;
- **the coordinate mapping, as pixels**: a 640x480 region at (600,400) compared
  against the matching rectangle of a full 4K capture differed in **0 of 307,200
  pixels**;
- `include_cursor`, whose draw is confirmed by the Win32 call's own result and
  was then confirmed by eye;
- per-frame cost by area inside a burst, beside the macOS figures — 161ms at 4K
  against macOS's 155ms, 12-29ms at component sizes against 47-56ms.

Not verified, and named here rather than implied away:

- **A second display.** The machine has one. The ordering rule (main first,
  1-based) is asserted as a pure function against a two-display payload, and the
  index round trip is asserted for index 1 only, so the "does `display 2` really
  capture the second screen" check that macOS needed has not been repeated here.
  The origins the inventory reports are what would make it checkable.
- **A locked or disconnected session.** Producing that frame for real means
  locking the machine, which is not something a test should do to its user; the
  detection is covered by the sampler's threshold cases and by a frame that is
  black for a different reason.
- **A harness running as a service.** The preflight exists for exactly that
  case and was verified in the direction that says "you may capture"; the other
  direction has not been observed.
- **A visible console window.** The child is spawned with `windowsHide`, which
  is the documented flag for it, and which this project has already seen matter
  in a sibling plugin whose restart helper flashed a PowerShell window and killed
  the server when it was closed. On this machine the capture came from a session
  that already had a console, so the failure mode could not be reproduced to
  prove the flag is what prevents it.

## Adding a third platform

1. Write `lib/platform/<id>.mjs` exporting an object with `id`, `capture`,
   `listDisplays`, `permission`, `briefing` and `interactiveModes`, per the
   contract documented in `lib/platform.mjs`. That file is the whole
   specification, and `lib/platform/darwin.mjs` and `lib/platform/win32.mjs` are
   two worked examples of it, one with a consent model and one without.
2. Register it in the `PLATFORMS` map in `lib/platform.mjs`. That is what makes
   the runtime gate open — `index.mjs` asks the registry rather than naming a
   platform, so there is nothing else to enable.
3. Update the `disabled: !!js` expression in `cordis.patch.yml` to match. This
   is the one place that has to repeat the answer, because the loader evaluates
   it without access to the module, and a self-test case evaluates it against
   the registry on every run so the two cannot drift.
4. Add the platform to the description and the READMEs, and record in
   `docs/verification.md` what was run on which machine — including the parts
   that were not.

`captureBurst` is optional: leave it out and `lib/capture.mjs` drives the burst
frame by frame, which is the right answer wherever a capture does not cost much
more than a frame.
