# Debugging and verifying this plugin on macOS

**给用户的摘要（中文）**：这份文档是写给 Mac 上那个 AI 的，它不需要任何上下文就能照做。
打开 `docs/macos-debugging.md`，让它从"Step 0"开始逐项执行，把每项的结果按最后的模板回报。
里面每一项都写了**怎么跑、期望看到什么、出现了偏差意味着什么**，以及要回报哪些数字。
Windows 端的全部实测已经完成，Mac 端唯一完全没跑过的是"变化检测"和"静止判定"这两条新路径。

This document is written for an agent that has just been handed the repository and
has no memory of how it got here. Everything it needs is below; nothing depends on
reading the rest of `docs/` first, though `docs/motion.md` explains *why* the design
is what it is and is worth reading before changing any of it.

Do the steps in order. Each one says what to run, what the answer should be, what a
deviation means, and what to report. **Report what you measured, not what you
expected** — every number below that is written as a Windows measurement is there
precisely because the macOS numbers are not known yet, and a sentence like "it
seemed fine" is worth nothing to the next reader.

## What this plugin is, in one paragraph

`dsh-screen-eye` gives a DeepSeek Harness agent eyes: a `screenshot` tool that
captures the screen and returns the image in the same call, plus a
`screen_permission` tool that reports whether macOS has granted Screen Recording.
On macOS every capture is `/usr/sbin/screencapture` — there is no helper process, no
compiled binary, and nothing that would change the binary signature and invalidate
the grant. The tool also takes **bursts**: `frames` captures spaced by
`interval_ms`, waiting for the picture to change first (`wait_for_change`) and
ending when it settles (`until_still`, which is implied whenever the call waited
for a change).

## Step 0 — get the suite green, and record what it says

```sh
node test/selftest.mjs
```

Expect **125 passed, 0 failed, and 2 cases that run rather than skip**. Those two are
the ones about TCC denial and onboarding guidance: they skip on Windows and must
execute here. If the suite is not green, stop and report the failure — nothing below
is worth measuring on top of a broken build.

Report: the exact pass/fail/skip counts, and the output of `node --version`,
`sw_vers`, and `system_profiler SPDisplaysDataType | head -40`.

## Step 1 — permission, and the shape of the failure when it is missing

```sh
# What the harness sees, through the plugin's own tool, is a text report.
node -e "import('./lib/permission.mjs').then(async (m) => console.log(await m.probeScreenRecording()))"
```

Expect a granted state on a machine where the harness has been allowed. Then check
the *denied* path deliberately, because it is the failure a real user hits first:

1. System Settings → Privacy & Security → Screen Recording → remove the entry for
   the process running the tests (Terminal, or the harness).
2. Run one capture (`node test/selftest.mjs` will do, or a single `screenshot` call).
3. Expect a thrown error that **names the fix** — the onboarding steps and the exact
   executable to grant — and not a raw TCC string.
4. Re-grant and confirm a capture works again. macOS may require the process to be
   restarted after the grant; if it does, that is worth reporting, because the
   plugin's guidance does not currently mention it.

Report: granted/denied states, and whether a restart was needed for the grant to
take effect.

## Step 2 — a capture, and the coordinate mapping

The plugin's `region` is in **screen points**, the same coordinates the rest of the
macOS UI uses. Prove it rather than assume it:

```sh
# Take a full-screen capture and a region at a known offset, then compare the
# region against the matching crop of the full capture. They must be identical.
node -e "
import('./lib/capture.mjs').then(async (m) => {
  const s = await m.captureScreen(m.planCapture({ mode: 'screen' }), { outputPath: '/tmp/full.png', signal: new AbortController().signal });
  const r = await m.captureScreen(m.planCapture({ mode: 'region', region: '200,200,400,300' }), { outputPath: '/tmp/crop.png', signal: new AbortController().signal });
  console.log(s, r);
});"
```

Then compare pixels (any tool will do; `sips` and `python3 -c` with PIL if present).
On a Retina display the full capture is twice the point size, so compare the region
against the **2x** crop — that is the check, not a discrepancy.

Also verify `mode: 'displays'` reports each display's origin, and that a region with
a **negative x** (a display to the left of the main one) captures the right pixels.
This is verified on Windows with two screens; on macOS it is not verified at all.

Report: point size vs pixel size of the main display, whether the region matched the
crop, and the `displays` output.

## Step 3 — **the one that matters most**: does a still picture read as still?

Windows answers "has it stopped?" by sampling a few thousand pixels and asking how
many moved. macOS has no resident helper, so it answers by capturing the rectangle
and comparing **sha256 of the PNG with its descriptive chunks stripped**
(`lib/platform/darwin.mjs`, `sampleScreen`). That is an all-or-nothing comparison,
and it can only work if two captures of an unchanged screen produce *identical*
bytes after `stripDescriptiveChunks`.

That is the assumption to test, because if it is wrong the burst never sees a still
frame, never ends early, and quietly runs to its frame ceiling instead:

```sh
node -e "
import('./lib/platform/darwin.mjs').then(async (d) => {
  const { planCapture } = await import('./lib/capture.mjs');
  const { readFile } = await import('node:fs/promises');
  const { stripDescriptiveChunks } = await import('./lib/png.mjs');
  const plan = planCapture({ mode: 'region', region: '0,0,400,300' });
  await d.darwin.capture(plan, '/tmp/a.png', {});
  await d.darwin.capture(plan, '/tmp/b.png', {});
  const [x, y] = await Promise.all([readFile('/tmp/a.png'), readFile('/tmp/b.png')]);
  console.log('raw equal        ', x.equals(y));
  console.log('stripped equal   ', stripDescriptiveChunks(x).equals(stripDescriptiveChunks(y)));
});"
```

Point the region at something genuinely still — an empty desktop area, not the menu
bar and not near the pointer.

- **stripped equal: true** — the still check works, and `until_still` is sound here.
- **raw equal: false, stripped equal: true** — the expected case, and the reason the
  stripping exists (a timestamp lives in an iTXt chunk).
- **stripped equal: false** — this is a real finding. Compare the two files' chunk
  lists (`python3 -c` with a PNG chunk walker, or `xxd | head`) and report **which
  chunk differs**. If it is a chunk that carries no pixels, `DESCRIPTIVE_CHUNKS` in
  `lib/png.mjs` needs it added; if the difference is in `IDAT`, the encoder is not
  deterministic for identical pixels and macOS needs the sampling approach instead.

Then test it end to end, which is the thing a user actually cares about:

```sh
node -e "
import('./lib/capture.mjs').then(async (m) => {
  // A still screen with still-detection on: it must stop after two extra frames.
  const plan = m.planCapture({ mode: 'region', region: '0,0,400,300', frames: 8, interval_ms: 100, until_still: true });
  const burst = await m.captureFrames(plan, { outputPath: '/tmp/still.png', signal: new AbortController().signal });
  console.log(burst.frames.length, burst.spacingMs, burst.endedBecause);
});"
```

Expect **3 frames and `endedBecause: 'still'`** (one to start, two to confirm), not
8. If it reports 8 with `endedBecause: 'frames'`, Step 3's byte comparison is the
place to look, and the finding is important enough to report before changing code.

## Step 4 — the wait, and what it costs

`wait_for_change` polls: every 20ms it asks whether the rectangle changed, and the
macOS answer costs one `screencapture` (measured on the Windows side as 47ms for a
component-sized region, 155ms for a 4K screen — **the macOS numbers are unknown and
are part of what this step is for**). A change has to be confirmed twice before the
burst starts.

Open the fixture — a self-triggering 300ms transition, so nothing has to be clicked:

```sh
open tools/motion-fixture.html      # in whatever browser is default
```

Make the window large (full screen is ideal), then find the block's region with one
capture first — the block is pure red `#dc1428` on white, so it is unmistakable. The
track does not move with the window: it is the window's width minus 4% on each side,
220 points tall, its top edge 30% down the window. So if the window occupies
`wx,wy,ww,wh` in screen points, the region to watch is
`<wx + 0.04*ww>, <wy + 0.30*wh>, <0.92*ww>, 220`. Then:

```sh
node -e "
import('./lib/capture.mjs').then(async (m) => {
  const plan = m.planCapture({ mode: 'region', region: '<x,y,w,h of the track>', interval_ms: 40, wait_for_change: true, wait_timeout_ms: 15000 });
  const t0 = Date.now();
  const burst = await m.captureFrames(plan, { outputPath: '/tmp/anim.png', signal: new AbortController().signal });
  console.log('frames', burst.frames.length, 'spacing', burst.spacingMs, 'ended', burst.endedBecause, 'took', Date.now() - t0);
});"
```

Do it a few times, and while it runs watch the process list:

```sh
while true; do ps -A | grep -c screencapture; sleep 0.2; done
```

What to record, and why each number matters:

| measurement | why it matters | Windows, for comparison |
| --- | --- | --- |
| delay from the transition starting to the first frame | this is the wait's whole value; if it exceeds ~150ms, a 300ms animation loses its beginning | 103ms |
| frames inside the 300ms of movement | whether the motion is resolvable at all — 4-5 is enough to read direction, distance and easing | 4-5 of 7-8 |
| `endedBecause` | whether the burst ended on the motion or ran out its ceiling | `still` after 7 frames |
| achieved `spacing` vs the 40ms asked for | macOS pays a process start per frame; the floor is the real limit on resolution | 48-56ms |
| `screencapture` processes alive during the wait | the polling cost is the price of having no resident helper | n/a — 18ms in-process check |

Then the false-trigger check, which is the other half of the wait's design: point a
`wait_for_change` burst at a rectangle that is **not** changing — a blank area, the
menu bar, a static window — and confirm it **times out and fails** rather than
firing. The menu bar is the interesting case: if the rectangle includes the clock,
a minute boundary is a real change and the burst is right to fire. Verify that the
0.25% threshold and the two-confirmation rule behave sensibly rather than firing on
a cursor blink or a caret.

## Step 5 — the budget, and where the call ends

The call's budget (`timeout_ms`, default 300000) covers the wait *and* the capture;
the capture gets what the wait did not spend, and a wait longer than the budget is
clamped to the budget. Verify the clamp is visible rather than silent:

```sh
node -e "
import('./lib/capture.mjs').then(async (m) => {
  // Ask to wait far longer than the call may take. It must give up at the call's
  // own budget and say so.
  const plan = m.planCapture({ mode: 'region', region: '0,0,200,200', interval_ms: 100, wait_for_change: true, wait_timeout_ms: 60000 });
  try {
    await m.captureFrames(plan, { outputPath: '/tmp/w.png', signal: new AbortController().signal, timeoutMs: 3000 });
  } catch (error) { console.log(String(error.message)); }
});"
```

Expect the message to name the budget it actually used and to point at
`timeout_ms`, not to report 60000ms as if that were honoured.

## Step 6 — the interactive modes, by hand

`mode: 'window'` and `mode: 'select'` are the two modes macOS implements by asking
the user to click or drag. They cannot be automated, so they are exercised by a
person:

```sh
node -e "
import('./lib/capture.mjs').then(async (m) => {
  for (const mode of ['window', 'select']) {
    const shot = await m.captureScreen(m.planCapture({ mode }), { outputPath: '/tmp/' + mode + '.png', signal: new AbortController().signal });
    console.log(mode, shot.bytes);
  }
});"
```

The instruction is on screen and the call blocks until the user acts. Note whether
`window` needs a click or can be dismissed with Escape, what happens when the user
cancels, and whether the resulting PNG is what was pointed at. On Windows `window`
is not interactive at all — it captures the front window — so this is a genuine
platform difference and the tool description says so.

## Step 7 — multi-display and Retina, if the machine has them

- Two displays: capture `mode: 'display'` for each, in the order `displays` lists
  them, and confirm each image is the right screen and the right size.
- A display left of the main one: `region` with a negative x must address it.
- A Retina display and an external 1x display **in the same capture session**: this
  is the case most likely to be wrong, because the coordinate space is points
  everywhere while pixels differ per screen. Report the pixel size of each capture
  against the point size `displays` reports.

## Step 8 — what to report back

Write it as a file (`docs/macos-findings.md` is a reasonable place) rather than as a
chat message, and structure it as:

```markdown
# macOS findings — <date>, <macOS version>, <hardware>

## Suite
125 passed, 0 failed, 2 executed.

## Step 3 — still detection (the load-bearing assumption)
stripped equal: <true|false>; raw equal: <true|false>
still burst: <n> frames, endedBecause=<still|frames>
<if false: which chunk differed, and what it carries>

## Step 4 — the wait
first frame <n>ms after the transition started
<n> of <n> frames inside the 300ms of movement
spacing asked 40ms, achieved <n>ms
endedBecause=<...>
screencapture processes during the wait: <n>
false-trigger check: <timed out|fired; what moved first>

## Step 5 — budget
<the exact error message, which is the evidence>

## Steps 1, 2, 6, 7
<granted/denied, restart needed?, region vs crop identical?, the two interactive
modes, and the display sizes>

## Anything that contradicts docs/motion.md
<quote the sentence that is now known to be wrong, and the measurement that
contradicts it>
```

The last section matters more than the others. Every claim in `docs/` is written to
be falsifiable, and the macOS numbers in it are estimates marked as estimates; a
measurement that disagrees with one is the most valuable thing this run can produce.

## What is already known, so you do not re-derive it

- The macOS capture path is **unchanged** from the plugin's first version except for
  the additions described in `docs/motion.md`: the wait (`watch`/`changed`), the
  still ending, and the shared budget. If a plain single capture behaves differently
  from the published plugin, that is a regression and outranks everything here.
- There is no `captureBurst` on macOS — the shared per-frame loop in
  `lib/capture.mjs` is used — because there is no resident process to amortise. That
  is a deliberate difference from Windows, not a gap.
- Windows keeps a PowerShell engine resident and answers a change check in 18ms; the
  numbers in the tables in `docs/motion.md` labelled Windows were all measured on one
  3840x2160 machine at 125% scaling with a second screen at x = -2560.
