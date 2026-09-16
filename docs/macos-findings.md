# macOS findings — 2026-09-16, macOS 26.6.2 (25G83), Apple M4

What was actually run on the macOS side, and what each result does and does not
prove. Written against `docs/macos-debugging.md`, which is the runbook this
follows step by step, and reported as measurements rather than as agreement.

Hardware: one display, `P27A6VP`, **3840x2160**, no Retina scaling — `UI Looks
like: 3840 x 2160`, so one screen point is one pixel here and the point-versus-
pixel distinction the runbook asks about does not arise on this machine. Node
v25.9.0. The harness runs as a child of the terminal, which holds the Screen
Recording grant.

## Suite

**130 passed, 0 failed, 0 skipped** — after fixing one defect the suite found
(see "Two defects" below). 136 cases are registered in total: 116 shared, 10 in
the live-capture block, 10 in the Windows-only block. macOS runs 126 of them; the
runbook's "135 passed" was a claim about a number that no longer matched the file
and is corrected in `docs/macos-debugging.md`.

## Step 1 — permission

`probeScreenRecording()` returns `{ authorized: true }` and the plugin's own
`screen_permission` tool agrees. The denied path was **not** exercised: producing
it means removing the grant, and on this machine the grant belongs to the
terminal that is running the session — revoking it mid-run would have killed the
session doing the measuring. The classification, the onboarding text and the
grant target are asserted by the suite; what is missing is a live denial.

## Step 2 — a capture, and the coordinate mapping

The mapping was measured rather than assumed. A full-screen capture and a region
at `200,200,400,300` were decoded to raw pixels and compared:

```
compared 360000 channels (400x300 x3)
differing by >8: 0  (0.000%)  max delta 0
```

**The region is an exact crop of the same pixel grid**, so what the model measures
inside a region is what `region` addresses. The same was then checked between the
two capture engines, on a strip of desktop that does not change:

```
600x60 vs 600x60 -> differing>8: 0 of 108000
```

`mode: "displays"` reports the one display with its size; a second display and a
negative-origin region could not be tested here, because there is one screen.

## Step 3 — still detection (the load-bearing assumption)

The runbook's premise is that two `screencapture` outputs of an unchanged
rectangle are byte-identical **once their descriptive chunks are stripped**,
because the still check hashes rather than samples. Measured:

```
raw equal        true
stripped equal   true
stripped sizes   20732 20732
```

Repeated for three rectangle sizes — `400x300`, `1400x300`, `2000x1200` — with
eight captures each: **one distinct stripped hash in every case, and one distinct
raw hash too**.

So the assumption holds, and it holds *more strongly* than the document claims:
on this macOS release `screencapture` writes no timestamp at all, so two captures
of a still screen are byte-identical even before stripping. `docs/macos-debugging.md`
and `lib/platform/darwin.mjs` both described an iTXt timestamp as a fact; it is
not one here. Stripping stays, because "this encoder happens not to write a
timestamp" is a fact about one release rather than about the platform.

The end-to-end still ending behaves exactly as the runbook predicted:

```
frames      : 3
spacingMs   : 101
endedBecause: still
took        : 266 ms
```

Three frames — one to start, two to confirm — from a plan asking for 8, ending on
the picture rather than the count.

## Step 4 — the wait, and what it costs

### What a check costs

| operation | measured |
| --- | --- |
| one `screencapture` of a 400x300 region | 47.7ms median (min 44.9, max 51.7) |
| one `screencapture` of a 1200x800 region | 55.8ms median |
| one `screencapture` of a 1920x1080 region | 67.9ms median |
| one `screencapture` of the full 4K screen | 126.6ms median |
| one `darwin.changed()` on a 1400x300 region | 55.8ms median of the call, 68-90ms per poll cycle |
| one resident fingerprint of the same region | **22.6ms** |

The poll loop is `max(20ms sleep, check cost)`, so on a component region macOS
polls at about **68-90ms**, not the 20ms the code's constant suggests. Each poll
runs a whole `screencapture` process and is thrown away.

### Does the wait catch the animation?

Measured against `tools/motion-fixture.html` — a 300ms one-shot transition that
re-triggers every four seconds — through `captureFrames` with
`wait_for_change: true`, `interval_ms: 40`, four runs, with the block's position
recovered from each frame's own pixels:

| run | frames | spacing | ended | block left edge per frame |
| --- | --- | --- | --- | --- |
| 1 | 5 | 56ms | still | 1276, 1336, 1346, 1346, 1346 |
| 2 | 4 | 60ms | still | 1326, 1346, 1346, 1346 |
| 3 | 5 | 53ms | still | 1320, 1346, 1346, 1346, 1346 |
| 4 | 5 | 58ms | still | 1296, 1340, 1346, 1346, 1346 |

The block rests at 1346 and travels to 973, so its travel is 373px. **The burst
covers 20-70px of it: one motion frame, occasionally two.** The wait does detect
the transition and the still ending does work, but the frames that come back are
the *tail* of the animation, not its beginning. The runbook predicted this case
("If it reports 8 with `endedBecause: frames`, Step 3's byte comparison is the
place to look") — it is not the byte comparison that is at fault here, it is the
cost of a check.

A false-trigger check on a static rectangle behaves correctly: a
`wait_for_change` burst aimed at `0,0,300,200` **timed out after 6107ms** with
`nothing on screen changed within 6000ms, so there was no animation to watch`,
rather than firing on a cursor or a caret.

## Step 5 — budget

The clamp is visible rather than silent, exactly as documented:

```
nothing on screen changed within 3000ms, so there was no animation to watch.
That is this call's own budget (timeout_ms), not the 60000ms asked for: raise
timeout_ms if the wait needs longer. ...
```

## Step 6 — the interactive modes

Both modes were driven and cancelled with Escape rather than clicked, because a
capture of a rectangle nobody chose is not evidence of anything. Both exit
cleanly, and both then report:

```
select threw after 2882 ms: screencapture reported success but wrote no file
window threw after 2615 ms: screencapture reported success but wrote no file
```

That is a **misleading message for a user cancellation**: "reported success but
wrote no file" reads like a malfunction, when what happened is that the user
pressed Escape. It is the same sentence a genuinely empty capture would produce,
so there is no way for a reader to tell the two apart. Worth fixing; recorded
here rather than changed, because it is a message decision rather than a
measurement.

## Step 7 — multi-display and Retina

The first pass of this document said this step was "not applicable on this
machine: one display, no scaling", and recorded it rather than implying it away.
An iPad was then attached as a Sidecar display, and the step turned out to be the
most productive one in the run: **it found two defects, one of them silent, and
neither of them could exist on the machine the plugin was written on.**

### The two defects

**A scaled display was captured at its point size.** On the 2x Sidecar panel the
resident helper returned **1194x834** for a **2388x1668** screen — half the
pixels, with no error and no note, because a smaller picture of the right thing
still looks like a capture. ScreenCaptureKit speaks in points: `SCDisplay.width`
is the point width (1194) and `SCStreamConfiguration` wants pixels, so the
request asked the framework for a downscale.

The fix is one multiplier, and where it comes from is the whole story. The scale
must be read from the display *mode*: on this machine, in this process,
`CGDisplayPixelsWide` reports **1194** for the iPad — the point width, not the
pixel width — so the obvious `CGDisplayPixelsWide / CGDisplayBounds.width` ratio
evaluates to 1 and leaves the bug exactly where it was. Only
`CGDisplayCopyDisplayMode(...).pixelWidth / .width` gives 2388/1194 = 2.

**A region on a second display was refused outright.** `SCStreamErrorDomain
Code=-3812 "the operation could not be completed"`, for every rectangle. The
cause is a coordinate-space conversion: a request arrives in the desktop's global
coordinates — the space `region` is documented in — while `sourceRect` is
measured from the display's own top-left corner, so the display's frame origin
has to come off. On the main display `frame.min` is (0, 0) and every form of the
expression behaves identically, so a single-screen machine cannot tell the
correct one from the broken one. Measured on the Sidecar panel, subtracting both
components is the **only** form that captures anything:

| rectangle handed to `sourceRect` | result |
| --- | --- |
| global, unchanged | refused |
| subtract `minX` only | refused |
| subtract `minX` and `minY` | **400x300** |

That subtraction was in the code from the start and is correct. Worth recording
because the same session first removed it, on the strength of a probe that could
not distinguish the three forms, and the engine only kept working because the
main display's origin is zero. The lesson is the one this project keeps
relearning: a single-screen machine cannot test multi-screen behaviour, and the
test that "passes" there is not evidence.

Both fixes are measured end to end after the change:

| request | before | after |
| --- | --- | --- |
| iPad `display 2` | 1194x834 | **2388x1668** |
| iPad `region` (desktop coordinates) | refused | **400x300** |
| main `display 1` | 3840x2160 | 3840x2160 |
| main `region` | 400x300 | 400x300 |

### What the arrangement actually is

Read off the system rather than assumed, and each figure cross-checked:

- AppKit reports the Sidecar panel at frame `(-748, -834, 1194, 834)` in
  **points**, `backingScaleFactor` **2**, named `Sidecar Display (AirPlay)`;
- `system_profiler` independently reports it at **2388x1668** — the same panel in
  **pixels**, which is what confirms the 2x factor from a second source;
- ScreenCaptureKit reports it at frame `(-748, 2160, 1194, 834)`. Its origin
  agrees with AppKit's x, and its y is the main display's height, which is what a
  space whose origin is the main display's *top-left* would say;
- `screencapture -R` takes those coordinates and returns the region at the
  display's own scale: a 100x100 request on the main display comes back 100x100,
  and on the Sidecar panel 200x200.

`region` is therefore documented correctly and always was: the origin is the
main display's top-left, a display to the left or above takes negative
coordinates, and the Space is contiguous. What was missing was the plugin's
ability to *report* where a display sits.

### Where a screen is, now that the helper knows

`system_profiler` describes a display's size and whether it is the main one, and
says nothing about position — so the inventory could not say where a second
screen begins, a region aimed at one could not be reasoned about, and a capture
of one could not report its own origin. ScreenCaptureKit knows, because it has to
in order to capture at all, so `listDisplays` now merges the resident helper's
origins in: **additively**, with the profiler still the source of the list, its
order and its names, and the origin simply absent on a machine with no helper
rather than guessed. The model now sees

```
1. P27A6VP — 3840x2160 at 0,0 (main display)
2. Sidecar Display — 2388x1668 at -748,2160
```

and `screenOriginFor` reports an origin for `display` mode as well, so a
coordinate measured on either screen converts by addition exactly as a region's
does.

### What is still not verified

The arrangement measured here is one specific one: the iPad on the left, aligned
with the main display's top edge. macOS does not report where a display sits, so
the engine's placement of a **differently arranged** second screen — below, above,
or at a vertical offset — is untested, and it is the case to check next. The
region cases assert that a region succeeds on every display and reports the
origin it was given; they do not assert where the engine believes each screen
begins, because a test that guessed the arrangement would encode the guess as a
fact.

## The resident engine

`docs/macos-debugging.md` stated that macOS has no resident helper and that this
is "a deliberate difference from Windows, not a gap". The measurements above say
it is a gap, and this machine can close it.

### What was built and why it is possible

Apple obsoleted `CGDisplayCreateImage` in macOS 15, so ScreenCaptureKit is the
only supported way to read the screen and it can only be reached from a compiled
program — there is no interpreter for it. A helper was written in Swift, compiled
on this machine, and it **inherits the grant**: a child process spawned by an
already-authorised parent is attributed to that parent, so no second Screen
Recording prompt appears and no user action is needed. Verified by running the
compiled helper as a child of node and getting a full 3840x2160 frame with no
prompt.

Compile cost, once: **0.54-1.1s**. The binary is 80-95KB and is cached under the
temporary directory, named after a hash of its own source so a stale build can
never be mistaken for a current one.

### What it costs and what it buys

Interleaved measurements, resident helper against `screencapture`:

| capture | `screencapture` | resident engine |
| --- | --- | --- |
| 400x300 region | 47.7ms | **13.2ms** |
| 1200x800 region | 55.8ms | **18.4ms** |
| 1920x1080 region | 67.9ms | **29.2ms** |
| full 3840x2160 | 126.6ms | **81.9ms** |
| change check, 1400x300 | 55.8ms | **22.6ms** |

The number that matters is not the average but what it does to a burst. The same
fixture, the same 300ms transition, the same 373px of travel, watched through a
resident engine against the binary:

| arm | frames | spacing | x covered by the frames |
| --- | --- | --- | --- |
| today (`screencapture` per check) | 4-6 | 47-58ms | **24-98px** |
| resident engine | 8 | 45-47ms | **270-348px** |

The block's positions through the engine were `900, 1068, 1248, 1312, 1340, 1346`
— the animation caught from its first frame to its rest, rather than its last
third. This is the same improvement Windows got from its resident engine, for the
same reason, and it is what the "four or five frames of a 300ms transition" claim
in `docs/motion.md` was supposed to describe and does not.

### What was verified about the lifecycle, and what was not

- **No process survives.** After a session that warmed the engine, `ps` shows no
  helper; a node process that captures and exits does so on its own in 1409ms with
  the engine warm, because every stream is unreferenced and the engine exits when
  its stdin closes.
- **Both engines agree on pixels.** The same rectangle captured through each was
  compared: `0 of 108000` channels differ by more than 8.
- **A helper that is broken is invisible.** Any engine failure other than a
  Screen Recording denial falls back to `screencapture`, so a dead or wedged
  helper costs speed rather than the capture. A *denial* is reported instead,
  because retrying it would replace the onboarding message with a vaguer error.
- **Not verified**: a helper running under a harness started by launchd rather
  than by a terminal, where the responsible-process attribution that makes
  inheritance work may differ; and a machine with no Swift toolchain, which is
  the case the fallback exists for and which the suite covers by driving a real
  capture with no engine running rather than by uninstalling a compiler.

## Two defects this run found

1. **A case that failed on the platform it was written for.** `runScript` in
   `lib/platform/win32.mjs` checked for `powershell.exe` *before* writing the
   script file, so the case asserting that file's BOM and contents could not pass
   anywhere but Windows — it threw `the Windows capture engine needs
   C:\Windows/System32/...powershell.exe, which is missing`. The write now
   happens first and the host is checked after, which is also the order that
   makes the portable half of the claim testable; the Windows-only half ("a real
   PowerShell runs it") moved into the Windows block where it belongs.
2. **`URL.pathname` is not a filesystem path.** The engine's build step passed
   `new URL('./engine.swift', import.meta.url).pathname` to `swiftc`, which
   leaves percent-encoding in place: this checkout lives under a directory with a
   space in its name, so the compiler was handed a path containing `%20` and
   reported the file missing. `fileURLToPath` fixes it. A checkout with no spaces
   in its path would never have shown this.

## Anything that contradicts docs/motion.md

- *"On macOS the first frame lands 50-155ms after the call."* Through the binary
  that is roughly right for the call-to-frame delay; what it hides is that a
  **watched** burst does not start then. A wait has to notice the change first,
  which costs a 56-90ms check plus a second one to confirm, so the first captured
  frame lands 150-200ms into the animation and only its last third is recorded.
- *"macOS has the same wait, with a weaker instrument. It has no resident helper
  to ask"* — no longer true, and it was the assumption the whole macOS design
  rested on. There is a resident helper now, it inherits the grant, and it changes
  the numbers in the table above from the tail of the animation to all of it.
- *"a 47ms check plus one confirmation puts the first frame inside 150ms of the
  change, leaving four or five frames of a 300ms transition."* Measured, it
  leaves **one or two** motion frames of five to six captured. The arithmetic
  assumed the confirmation and the first frame are free; both cost a full check.
- *"`screencapture` stamps every file with a timestamp in an iTXt record"* — it
  does not on macOS 26.6.2; raw captures of a still screen are byte-identical.
  The stripping is insurance rather than the load-bearing step it was described
  as.
