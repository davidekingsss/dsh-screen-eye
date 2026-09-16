# Verification

What has actually been run, and what each result does and does not prove. The
point of writing it down is that "it works" is a claim, and a reader should be
able to tell which parts of it were executed and which were only reasoned
about.

## 1. Self-test — `node test/selftest.mjs`

124 cases, all passing, on Windows; 2 of them skip themselves there because they
are about the macOS Screen Recording model. The suite runs without a harness:
the logic modules are imported directly and the tool definitions are exercised
through a stubbed context.

It runs on both platforms the plugin serves, and CI runs it on both. Cases that
are about a platform's own model — the macOS permission classification, the
Windows script the engine would run — are asked of that model directly rather
than of the host, so they execute wherever the suite happens to be running. That
is what keeps the Windows half from being the untested half on a macOS machine,
and the reverse.

What they cover:

- argument validation, including the cases that must be **rejected** rather
  than repaired — malformed regions, a zero or negative region size, a region
  passed to a non-region mode, a display passed to a non-display mode, a zero
  or fractional display index;
- that a **negative region origin is accepted**, because that is how a display
  placed to the left of or above the main one is addressed, and rejecting it
  would put those displays out of reach;
- the mapping from each mode onto `screencapture` flags — including `-m` on the
  default mode, which is what keeps one call to one file — and that every mode
  produces PNG so the declared media type is true;
- output-path rules: absolute and `.png` only, and 200 generated names are
  distinct (two captures in the same second must not overwrite each other);
- capture naming and retention together: 500 generated names all satisfy the
  matcher retention uses to decide what it may delete, names this plugin did
  not write are never candidates, the newest N survive, `0` disables pruning,
  and the capture just returned is never among the removed — asserted both as a
  unit rule and against real files on disk. A capture the caller directs
  elsewhere with an explicit `path` is asserted **not** to prune the directory
  it lands in, with capture-shaped decoy files placed there so the scope, not
  the name filter, is what the case proves;
- that the schemastery defaults and the module fallbacks agree, because they
  are applied on different paths and a silent drift would make behaviour
  depend on how the plugin loaded;
- the image content blocks, including the downscale multiplier;
- the burst contract: that each pair of frames, interval and window settles the
  third, that a window alone is sampled at the ordinary frame count rather than
  the maximum, and that holding a window fixed while raising the interval is
  monotonically fewer frames — which is the cost lever, asserted as a
  monotonicity rather than as one example;
- the ending contract: that a burst which waited for a change ends when the
  picture settles without being asked to, that a photograph of the new state
  and a burst nobody waited for do not, that `until_still: false` restores the
  full window, that the cap widens to ten only when the caller named neither a
  count nor a window, and that both endings are described honestly in the
  envelope the model reads;
- schema conformance: every shape either tool can return — one capture, a burst,
  a burst that under-delivered, an inventory, an inventory missing a size, and
  each permission outcome — validated against the schema the tool itself
  declares, using the harness's own `validateJsonSchemaValue` on the compiled
  declaration. This exists because adding the inventory mode without widening
  the output declaration produced a tool that worked until it was called: the
  harness refused its return value with "returned invalid output". Only a live
  call revealed it; now CI does;
- the reply names the window it covered when one was asked for;
- metadata stripping: that a capture's descriptive chunks are removed and its
  dimensions survive, and that bytes the rewriter cannot handle safely — a
  non-PNG, or a PNG that never reaches `IEND` — come back exactly as they were
  rather than truncated into something corrupt;
- display ordering as a pure function, on the exact payload a real machine
  produced: main first even when the system lists it later, a Sidecar entry
  that omits `spdisplays_online` staying listed rather than being read as
  offline, a display with no name or size reported without inventing either,
  and an empty inventory treated as a failed reading rather than as a machine
  with no screens. The live enumeration is asserted too, and skips itself when
  the environment reports no inventory — which the CI runner does, and that
  is why the pure cases exist;
- bursts: the frame-count bounds, that an interactive mode cannot be repeated
  unattended, the interval default and validation, and — against the real
  screen — that three frames come back in one call as three committed images
  at three distinct paths, all of which keep the shape retention recognises,
  rendering as one envelope plus three image blocks. A separate case pins that
  a single capture still renders as one image, so burst support did not quietly
  change the ordinary contract;
- PNG geometry read straight from the file header — a real size, a buffer too
  short to hold one, a right-sized buffer that is not a PNG, a PNG whose first
  chunk is not `IHDR`, and a zero dimension — plus the `maxDimension` guard
  firing at a deliberately lowered cap and naming the real size, the cap and
  the remedy, and a capture that fits passing through;
- child-process execution, which is what makes the cancellation claim in
  `lib/exec.mjs` true rather than aspirational: an already-aborted call never
  spawns, cancelling mid-flight and exceeding the budget both **kill** the child
  — proved by a marker the child would have written two seconds later, not by
  observing that a promise rejected — and an unspawnable command rejects
  instead of hanging. This matters because the visible failure would be a
  crosshair left on the user's screen;
- permission diagnosis: a TCC denial is classified separately from every other
  failure, and the guidance names the exact executable to grant;
- the `screen_permission` tool itself — its live report on this machine, that
  `check` is the default action, and that both render outcomes name the path to
  grant. The settings-opened outcome is asserted to still report
  `authorized: false`, because opening a pane grants nothing and the text must
  not imply otherwise;
- the message a **denied** capture produces: it carries the onboarding steps
  and the computed grant target, and it *replaces* the raw
  `could not create image from display` rather than prefixing it, since that
  string reads like a bug and tells the user nothing they can act on. The
  non-TCC branch is asserted not to mention Screen Recording at all, so an
  ordinary failure never misattributes blame to the grant;
- tool wiring, asked of `apply()` with `process.platform` reporting each system
  in turn so the answer is not the host's: both tools on macOS, `screenshot`
  alone on Windows, and **nothing** on a host with no engine; that a tool-name
  collision leaves the host running and the other tool registered; and that the
  collision is then *discoverable* — `screen_permission` reports it, and its
  render drops the clean-bill-of-health sentence rather than claiming a working
  screenshot tool the plugin's own report contradicts;
- the bundle patch carries the platform gate, and the package stays
  installable (`dsh.bundle` present, every required file in `files`);
- the seam itself: that no OS-specific module is reachable from outside
  `lib/platform/`, checked by walking the real import graph rather than by
  trusting the rule — and the case was itself checked by adding a violating
  import and watching it fail. Without it the seam lasts until the next
  convenient import;
- that every registered platform implements the whole contract, since a
  half-implemented platform is worse than an absent one: it passes the gate and
  fails at the first call;
- that the patch's gate and the engine registry agree on every platform,
  evaluated by running the patch's own expression against the registry. They
  live where they cannot import each other, so this is the only thing keeping
  two copies of one fact from drifting — and the case was itself checked by
  making them disagree on purpose and watching it fail;
- the guide action never reports a state it did not observe: on a machine
  where the grant is already in place it opens nothing and explains nothing,
  and where it is missing it opens the pane and tells the model to confirm with
  a check rather than assume the fix worked;
- the Windows engine, as a pure mapping, on every platform: each mode onto the
  rectangle Windows should read, `select` refused with its remedy, the session
  preflight present in both scripts, DPI awareness declared *before* the screens
  are enumerated (the order is the whole point — measured at 3072x1728 before
  and 3840x2160 after on a 125%-scaled 4K panel), a path containing a quote
  escaped by PowerShell's own rule, the base64 round trip through
  `-EncodedCommand`, a burst carrying one path per frame and exactly one shim,
  and the marked result line being read out of noisy stdout;
- that the modes which wait for a person are the ones that really do, since that
  set is what refuses a burst: macOS's `window` waits for a click and Windows'
  does not, so a window burst is refused with one set and planned with the other,
  and the hand-written set in `darwin.mjs` is held equal to the default in
  `lib/capture.mjs`;
- the Windows inventory as a pure function: main first, 1-based, each display
  keeping its own origin, an unnamed display reported without inventing a size,
  and an empty inventory treated as a failed reading rather than as a machine
  with no screens;
- the black-frame report in both directions: it fires at the threshold, stays
  silent just below it — a false positive would put a warning on every capture a
  user takes — and carries the likely causes plus the admission that a genuinely
  black screen looks the same;
- that the tool description is built from the platform's own briefing: the macOS
  one still promises Screen Recording and the 155ms/56ms measurements, the
  Windows one says capture needs no consent, that `select` is unavailable and
  that a burst runs in one engine process, and neither carries the other's
  claims;
- that the wiring decisions hold for both platforms from either one, by asking
  `apply()` what it registers while `process.platform` reports each in turn:
  macOS gets both tools, Windows gets `screenshot` alone, and a host with no
  engine gets nothing;
- that a frame carrying a note still satisfies the declared output schema and
  still renders its image — the note rides beside the picture in the envelope —
  and that a capture without one renders exactly as it did before the field
  existed.

Cases that capture for real run only when the machine can actually see its own
screen — on macOS that means Screen Recording is granted, on Windows that the
process is attached to a visible desktop — so the suite is green before the
grant as well. On CI they skip: a hosted runner has no interactive desktop.

Every capture the suite takes goes into a temporary directory created for the
run and removed at the end, and the pruning case gets a directory of its own.
This is not incidental: an earlier revision wrote its live captures into the
plugin's *default* output directory, which is inside the user's harness home,
so running the tests left PNGs of the user's screen behind. The suite now
asserts that its captures land in the test directory, and the directory is
removed even when a case fails.

## 2. Loader acceptance — isolated profile

Booting a second harness instance against the real loader, with a profile
containing only `dsh-base`, `dsh-web-app` and this plugin:

- `dsh --profile verify --dump-config` shows the entry in the composed tree
  carrying its platform gate, which is that gate surviving composition. At the
  time of this run the gate read `disabled: !!js process.platform !== 'darwin'`,
  since macOS was the only engine; section 8 re-ran the same check on Windows
  against the expression as it stands now;
- a deliberately throwing `apply()` produced
  `failed to apply loader entry screen-eye (dsh-screen-eye)`, proving the
  module is imported, resolved from the profile, and applied by the official
  loader on darwin.

The throwing probe was removed immediately after the run; the module is not
shipped with it.

## 3. End-to-end — a real agent turn

`dsh --profile verify "<task>"` against a profile containing `dsh-base`,
`dsh-headless` and this plugin, with the instruction to capture the screen and
report what it saw. This is the test that matters, because it is the only one
that exercises the claim the plugin actually makes: that the agent can look at
the screen by itself.

Observed in that run:

- the agent chose `screenshot` on its own, from the tool description alone;
- it used `mode: "screen"` first and then `mode: "region"` about fifteen times
  to zoom into parts of the screen it could not read at full size, which
  confirms the region path and the coordinate guidance in the returned
  envelope;
- it read back content that can only come from the image — menu-bar items in
  Chinese, the clock, the text of the conversation visible in the harness
  window, and the body text of a GitHub page open in a browser;
- it noticed the screen was live, because the clock and a price readout had
  changed between two of its own captures;
- it correctly reported that a System Settings window was present but
  completely occluded, and therefore not visible in the pixels.

Artefacts that survived the run corroborate the modes used: region captures at
sizes such as 790x32 (a menu-bar strip) alongside full 3840x2160 captures, and
several captures written within the same second with distinct names — the
collision case the self-test asserts.

What this run does **not** establish: anything about Windows, and anything
about a host whose model route cannot accept images (that path is refused at
the gate and is covered by a self-test rather than by a live run).

A second run through the same profile checked the configuration path, since
the first one never exercised it: the agent chose its own filenames and passed
`path` explicitly every time, so the configured directory was untouched. With
the instruction to use the default location, a profile-level
`cordis.patch.yml` override (`outputDir`, `keepRecent`) reached the plugin —
the capture landed in the configured directory under the generated name, the
default directory stayed empty, and the agent reported that path verbatim.
That run also settled a question the code had been vague about: retention was
scoped to `dirname(captured.outputPath)`, which is not the configured directory
when the caller supplies a `path`. The README promised the configured
directory and the code did something else; the code now matches the promise,
because a directory a caller merely pointed one capture at is not a directory
retention should be walking.

## 4. In a real harness, unprompted

Two things were still unproven after the runs above: that the plugin works in a
harness someone actually restarted into, rather than an isolated profile built
for testing; and that an agent reaches for the tool **without being told it
exists**.

The first: with the plugin installed in the real `web` profile, the harness was
restarted, and both tools appeared in the session's tool list and were called
directly — `screen_permission` reporting `authorized: true`, and `screenshot`
returning a capture of the desktop that could be read back in detail. The
capture landed in the plugin's default output directory, so that run exercised
the configured default rather than an override.

The second: a one-shot run was given the task *"What is currently on my screen?
Describe what you see and read back any text you can find."* — no tool name, no
hint that a screenshot tool exists, nothing but the need to see. The agent
found it and used it: one full capture, then thirteen region crops to read what
was too small at full size, and an answer naming the browser page, the
conversation in the harness window, the menu-bar clock, the dock icons and a
running status line. It also named its own crops meaningfully and passed them
as `path`, which is the escape hatch working as intended.

That is the claim this plugin makes — an agent that looks by itself — checked
against an agent that was not told how.

## 5. Multi-display, actually exercised

This section exists because the earlier version of this file recorded
multi-display as reasoned about but never run: the development machine had one
display. A second screen was then attached — an iPad in Sidecar — which turned
three assumptions into observations.

- `system_profiler` listed both: the 4K monitor first, marked
  `spdisplays_main`, the iPad second at 2388x1668. The iPad entry **omits**
  `spdisplays_online` entirely, so an inventory that treated a missing key as
  offline would hide the second screen on exactly the setup it exists to
  describe. The enumeration does not require that key.
- **`-D`'s numbering matches that order.** `-D 1` captured 3840x2160 and
  `-D 2` captured 2388x1668 — the two screens, in the order reported. This had
  been an assumption; it is now a measurement, and it is what lets
  `mode: "displays"` hand out an index worth using.
- `-m` still captures only the main display, so the one-file-per-call contract
  holds on a multi-display machine.
- An out-of-range index fails cleanly and names the range:
  `-D 3` → "Invalid display specified. Must be a number from 1-2".
- The whole path was then walked through the tool rather than the binary:
  `mode: "displays"` listed both screens with the indices, and
  `mode: "display", display: 2` returned an image of the second screen at its
  own resolution (2388x1668, projected to 956x668 for the model). So the
  inventory hands out an index that the capture mode actually honours.

What remains unexercised: a **region with a negative origin** that actually
intersects a second display. Negative coordinates were verified to be accepted
by the binary, but on this arrangement both screens sit at or right of the
main display's origin, so there was still no rectangle to aim at.

## 6. What the plugin's logs are worth — a canary

Checked because a comment in the code asserted it, and the assertion was wrong.

A deliberately failing registration has to be reported somewhere, and the
obvious answer is the logger. To find out whether that answer is real rather
than assumed, a canary was written into `apply()` — one line each at `info`,
`warn` and `error` — and a profile containing this plugin was booted. **None of
the three appeared.** `dsh web` prints its banner and nothing else, and the
harness keeps no log file in the home directory.

So catching a failed registration is not enough on its own: the catch would
have turned "your harness will not start" into a plugin that silently does less
than it says — the failure mode this project has otherwise been careful to
avoid. Failures are therefore also recorded and reported through
`screen_permission`, which is the tool an agent reaches for when the screen
misbehaves. The canary was removed after the run.

## 7. Windows, actually exercised

The port is the one part of this project that could not have been written from
the development machine as it was: macOS cannot run a Windows engine, and an
untested engine would put a claim in the README that nobody had falsified. So it
was written on Windows — one display, 3840x2160 at 125% scaling, Windows
PowerShell 5.1, window station `WinSta0` in session 1 — and everything below was
observed there.

- **The four unattended modes**, through the engine and through the tool:

  | mode | result |
  | --- | --- |
  | `screen` | 3840x2160 — the panel's true resolution |
  | `display 1` | 3840x2160, through the index the inventory handed out |
  | `region 100,200,640,480` | 640x480, exactly as asked |
  | `region 0,0,320,240`, `frames: 3, interval_ms: 200` | three frames, one engine call, spacing ~200ms |
  | `window` | 3840x2109 — the maximised foreground window, clamped to the desktop |

- **A region really is a crop of the same pixel grid.** A 640x480 capture at
  (600,400) was compared pixel by pixel against the corresponding rectangle of a
  3840x2160 capture taken moments earlier: **0 of 307,200 pixels differed**
  (tolerance 8 per channel). That is the mapping the zoom workflow depends on —
  what the model measures inside a region is what `region` addresses — and it is
  now a measurement rather than an inference from matching sizes.
- **Two screens, the second one left of the main.** A 2560x1600 panel at
  x = -2560 is the arrangement that breaks naive engines, and every row below was
  checked by comparing pixels rather than by reading sizes:

  | check | result |
  | --- | --- |
  | inventory | `1: DISPLAY1 3840x2160@0,0 main`, `2: DISPLAY2 2560x1600@-2560,0` |
  | `display 1` / `display 2` | 3840x2160 and 2560x1600, each the size the inventory reported |
  | `screen` vs `display 1` | identical but for 51 of 600,000 pixels — the live clock and cursor |
  | `region -2560,0,600,400` vs `display 2` at (0,0) | **240,000 of 240,000 identical** |
  | seam region, left half vs the left screen's right edge | **60,000 of 60,000 identical** |
  | seam region, right half vs the main screen's left edge | **60,000 of 60,000 identical** |
  | `region 3200,0,600,400` vs `display 1` at (3200,0) | **240,000 of 240,000 identical** |
  | `display 3` | refused: "does not exist: this machine reports 2 display(s)" |
  | `region -4000,0,600,400` | refused: "does not overlap any display; this desktop spans -2560,0 6400x2160" |

  The seam is the point: the desktop is one continuous 6400-pixel-wide plane
  starting at -2560, so a rectangle straddling the boundary is stitched from both
  screens with no gap and no offset, and the refusal reports that span rather
  than the main display's. `window` clamps to the same span, so a foreground
  window on either screen is captured whole. Mixed scaling changes none of it,
  because per-monitor-v2 awareness puts every coordinate in physical pixels — a
  DPI-unaware engine would see a shorter desktop with a gap where the seam is.
  A self-test case now walks this ground and skips itself on a one-screen machine.
- **Per-frame cost, by area, inside one engine call** — the number that decides
  whether a burst can sample motion at all, next to the macOS figures from
  `motion.md`:

  | captured area | Windows (in a burst) | macOS (per frame) |
  | --- | --- | --- |
  | 3840x2160, whole screen | 161 ms | 155 ms |
  | 1920x1080 | 60 ms | 71 ms |
  | 1200x800, a component | 29 ms | 56 ms |
  | 600x400 | 13 ms | 51 ms |
  | 200x150 | 12 ms | 47 ms |

  Windows matches macOS at full screen and beats it on small regions, because
  macOS pays about 45ms of process start per frame while a Windows burst pays
  the PowerShell start once. What Windows cannot match is a *single* call:
  **~380ms** in steady state against 47-155ms on macOS, of which 148ms is
  `powershell.exe` starting with nothing to do. That is the price of having no
  capture binary to call, and it is why bursts are one process.
- **The shim cache, A/B against compiling in memory** — the two arms
  interleaved, because this machine's process start swings by more than the
  effect: **384ms against 561ms**, so compiling the C# once per machine and
  loading the assembly afterwards is worth **177ms a call**. The measurement is
  also the reason the numbers in this file are medians of interleaved runs: the
  same code, unchanged, produced stretches of 380ms and stretches of 2.5-3.5s
  within one session, and a single unpaired sample here is worth nothing.
- **A 300ms animation, watched and reconstructed.** The strongest evidence that
  the burst path works the way the tool claims, because the truth is known
  exactly: a 60px block crossing 660px in 300ms, repeating every 700ms, rendered
  on screen while the engine captured it, with the block's position recovered
  from each frame's own pixels.

  | capture | achieved spacing | what came back |
  | --- | --- | --- |
  | `region 0,0,1300,600`, `frames: 10, interval_ms: 40` | 48-50ms | the block in **10 of 10 frames**, 5-6 of them mid-movement: 285 → 413 → 542 → 675 → 807 → 938 px |
  | `screen` 4K, `frames: 6, interval_ms: 170` | 184ms | the block in all 6, but only one of them mid-movement |

  The speed recovered from the frames is **2207-2787 px/s against a true
  2200 px/s**, and one burst covers up to 750 of the 660 px the block travels:
  direction, distance and duration are all readable off the sequence. At full
  screen the same animation yields one usable frame, which is the macOS result
  as well — 155ms a frame on both platforms. The interval floor was measured
  separately, asking for 10/20/40/80/160ms and getting 19-23ms on a 400x300
  region, 23-48ms on 1300x600 and 155-178ms at 4K: `max(target, frame cost)`
  plus about a dozen milliseconds, the same rule macOS follows with a 47ms floor
  on a component-sized region.
- **What a burst cannot do on Windows**: start instantly. Its first frame lands
  ~380ms after the call, against 50-155ms on macOS, because the engine has to
  exist first. A looping animation is unaffected; a one-shot transition that
  began before the call can be missed entirely. `docs/motion.md` has the numbers
  and the workflow that follows from them.
- **A transition that runs once**, watched end to end. This is the case the
  earlier animation test did not cover, and the one that matters: a component
  animation does not loop, so a burst has to start on *the animation*, not on
  the call.

  The animation is armed and standing still; the burst is issued with
  `wait_for_change: true`; the "user" triggers it six seconds later.

  | measurement | result |
  | --- | --- |
  | the call itself | returned after 5.3s, having waited for the trigger |
  | change detected, first frame taken | **103-109ms after the trigger** |
  | frames | 8 at 47ms spacing |
  | frames inside the 300ms movement | **4-5 of 8** |
  | positions recovered from the frames | 509 → 638 → 771 → 899 → 1032 |

  Direction, distance and duration are all readable off that sequence. Before
  the resident engine and the wait, the same experiment gave **zero** usable
  frames: the first frame arrived 380ms after the trigger, by which time the
  transition had finished.
- **Three defects this work found, each of which had to be fixed before the
  numbers above were possible.**

  1. **The engine hung.** Its script was handed over with `-EncodedCommand`, and
     in that mode stdin belongs to the host — `[Console]::In.ReadLine()` never
     returned. The engine is now started with `-File` from a cached script.
  2. **A Chinese path broke the capture.** Windows PowerShell decodes a
     redirected stdin as ANSI, so a request carrying `…\中文目录\shot.png` arrived
     as mojibake and GDI+ failed with *"GDI+ a generic error occurred"* — while
     the same capture through the one-shot path worked, because that path passes
     its script as UTF-16 base64 and never touches stdin. Fixed by declaring
     `[Console]::InputEncoding`; a live case now captures into a `中文目录`, and
     the ASCII-versus-Unicode split is what identified it (400 fingerprints
     before a save, on an ASCII path, all succeeded).
  3. **The child kept the parent alive.** A referenced child holds the event
     loop open, so a resident engine meant a harness that would not exit — a
     worse bug than a slow capture. Unreferencing the process and its three
     streams fixed it: the engine leaves when its stdin closes, which is also
     how a crashed harness cleans up after itself. Verified: no `powershell`
     process survives the suite.
- **DPI is not a detail.** The same panel reported 3072x1728 to a DPI-unaware
  process and 3840x2160 after the shim declared per-monitor-v2 awareness, in that
  order, with the awareness call in between. Windows PowerShell is unaware by
  default, so the naive engine would have captured a 25% downscale of the screen
  and called it a capture. The self-test now pins the order of those two
  statements in the generated script, because a scaled capture looks exactly like
  a correct one.
- **The refusals name the cause**: `display 99` → "display 99 does not exist:
  this machine reports 1 display(s)"; a region at `-9000,-9000` → "does not
  overlap any display; this desktop spans 0,0 3840x2160"; `select` → the mode has
  no Windows equivalent, with `region` suggested. All three are the cases where
  the naive engine returns a black frame or a plausible picture of the wrong
  thing instead.
- **The black-frame note, end to end.** A rectangle overlapping the desktop by a
  single pixel produced a frame that is black everywhere; the tool returned the
  image *and* the note explaining what such a frame means, and the render put it
  in the envelope beside the image. A real desktop capture produced
  `blackPermille: 1` — 0.1% — and no note, which is the other half of the claim:
  the check does not cry wolf on the ordinary case.
- **The bytes the store is handed are the bytes it keeps.** `sharp` — the
  library behind the attachment store — reports a Windows capture as `png`,
  `uchar`, `srgb`, `hasProfile: false`, with no retained metadata, which is
  exactly the store's `canPassThroughNormalization` condition. So the capture is
  stored as written rather than converted at admission, and for a different
  reason than on macOS: GDI+ writes `sRGB`, `gAMA` and `pHYs` but no `iCCP`,
  `eXIf` or `iTXt`, so the strip step has nothing to remove (575870 bytes in,
  575870 bytes out). What the *route* then projects for the model — a downscale
  to its pixel budget — is the harness's own step and happens on both platforms
  alike; see section 8.
- **Timing, measured rather than assumed**: PowerShell start plus `Add-Type`
  about 600ms; a full-screen frame ~150ms (63-82ms to read, 80-86ms to encode);
  an 800x600 frame ~16ms; a complete single capture 0.5-1.5s depending on what
  else the machine is doing; the inventory ~460ms. That profile — a fixed cost
  that dwarfs the frame — is why Windows implements the optional `captureBurst`
  and takes a whole burst in one process, and the live burst case asserts a
  spacing under 700ms, which a per-process engine could not reach.
- **The pointer.** `CopyFromScreen` never includes it, so `include_cursor` is a
  claim about a path of this code: the shim draws it with `DrawIconEx` after the
  copy and reports the call's own result, which the case asserts. It was also
  confirmed by eye in the live session below: the arrow is in the picture.
- **A path that would break the script.** A capture directory named `it's mine`
  is quoted by PowerShell's own rule rather than by hope, asserted as a pure
  case.

Not verified on Windows, and recorded rather than implied away: a second display
(the machine has only one — the ordering rule is asserted as a pure function
against a two-display payload, and the index round trip only for index 1); a
locked or disconnected session (producing that frame means locking the machine,
which a test should not do to its user); a harness that really is running as a
service (the preflight exists for that case and was verified in the direction
that allows capture); and a visible console window proving that `windowsHide` is
what prevents it, because the capture ran from a session that already had a
console.

## 8. Through the real loader, on Windows

The engine cases above run the engine; this run went through the official loader
and a real agent turn, on the same Windows machine. An isolated profile
(`verify`) was built from the shipped `headless` template with this checkout
linked into it, which is the same shape section 2 used on macOS.

The everyday `web` profile was installed the same way, except that `pnpm` could
not be used for it: adding *any* dependency to that profile re-resolves its
graph, and an already-installed plugin's peer ranges (`@deepseek-ai/*` at
`^0.1.5-rc.1`) no longer resolve against the registry's current dist-tags, so
`pnpm install --lockfile-only` fails there with nothing added at all. The plugin
was recorded in `package.json` and linked into `node_modules` by hand instead —
the same two things `pnpm add` would have produced — and the composition and
resolution were then checked. That is an environment finding rather than a
plugin one, and it is recorded because the next person to install anything into
that profile will meet it.

- `dsh --profile verify --dump-config` composed the plugin into the tree with
  `disabled: !!js process.platform !== 'darwin' && process.platform !== 'win32'`
  — the gate, surviving composition, on a platform where it opens rather than
  closes. (The same check on macOS, when there was one engine, is section 2.
  What the expression *evaluates to* is checked against the engine registry on
  every run by a self-test, because the loader has no access to the module.)
- A one-shot agent turn was given the task *"Look at my screen and report
  back"* with no tool name and no hint that a capture tool exists. It found
  `screenshot` from the description alone and called it, which is the claim
  section 4 checked on macOS now holding on Windows as well.
- That call was **refused**, correctly, and the refusal is worth reading
  precisely: the harness's model *metadata* for `deepseek-flash` declared no
  image input — `settings.yaml` overrode the built-in catalog entry, which does
  declare `["text","image"]` — and the guard named the model and the setting
  that lifts it. So a Windows mount also exercises the guard, and its message is
  the one the model reads. It is a statement about the declaration, not about
  what the model can do; the difference is what section 8.1 had to unpick.
- With the guard lifted, the capture ran end to end: a 3840x2160 capture was
  committed to the attachment store — the harness itself reported
  `[image omitted because this model accepts text only; attachment
  sha256:51f02017]` — projected to 2730x1536 for that route, and written to the
  output directory the profile's patch configured.

### 8.1 An agent that can actually see a Windows screen

The run above stopped at the model's doorstep, because the harness's model
metadata declared no image input. That metadata is a *declaration*, not a
capability: the built-in catalog for `deepseek-flash` lists `["text","image"]`,
and this machine's `settings.yaml` overrode the entry with `["text"]`. So the
last link was tested twice over, in environments where the declaration says what
the model can do.

**In an isolated `DSH_HOME`** (a copy of the settings with `image` added, so the
user's own configuration was untouched), a one-shot turn was asked to capture
the screen and report the taskbar clock. It did, and reported
`captured_at 2026-09-16T02:35:12.259Z` with `clock 10:35`. This machine is
UTC+8, so 02:35:12Z *is* 10:35 local: the reading is verifiable against the
capture's own timestamp rather than taken on trust. It also cropped the capture
itself with PowerShell to zoom into the clock before answering — the zoom
workflow from section 3, on the other platform.

**In the real profile.** The plugin was installed into the everyday `web`
profile and the harness restarted, and the session that is writing this then
used its own tools. Getting there needed the declaration fixed rather than the
plugin: `settings.yaml` now lists `image` among `inputModalities` for
`deepseek-flash`, a one-line change to the user's own configuration (backed up
first), and it took effect without a further restart — the very next capture
came back with an image.

- `mode: "displays"` returned `\\.\DISPLAY1 — 3840x2160 at 0,0 (main display)`,
  the Windows inventory shape with the origin the port added;
- `mode: "screen"` returned the desktop at 2730x1536 as projected from a
  native 3840x2160 capture, and the UI was legible: sidebar labels, per-item
  timestamps ("1分钟", "7小时"), the window title and the model picker;
- `mode: "region", region: "0,0,860,1340"` came back as an **860x1340 PNG with
  no downscale at all** — every sidebar label readable, at one pixel of image
  per pixel of screen. That is the macOS zoom workflow, verified by eye rather
  than by argument;
- `include_cursor: true` put the pointer in the picture;
- `frames: 3, interval_ms: 150` returned three PNGs in one call at 163ms
  spacing.

The whole tool surface was driven that way, not only the happy paths: the
inventory, all three burst-planning forms, `window` with the pointer, and the
refusals for `display 99`, `select`, a region off the desktop and an
over-large frame count. Every one behaved as `docs/windows.md` says — except
the two below.

### 8.2 Two things this run found, and what was done about them

Testing through the real tool surface is what surfaced both; neither was
visible from the engine cases, because both are in the layer the model reads.

1. **A burst that met its target was reported as having missed it.** The sleep
   loop targets the interval and then starts the next frame, so a burst that met
   its target still lands a few milliseconds over — and every one of them was
   labelled *"asked for 150ms, which a capture of this size cannot meet; a
   smaller region is captured faster"* (measured: 200ms asked, 211ms achieved;
   150ms asked, 163ms achieved). The advice is about the frame cost, which in
   those captures was 13-29ms and could not have helped. `formatBurstOutput` now
   needs a shortfall of more than a quarter of the interval or 25ms before it
   says the interval was missed; a 40ms request answered with 155ms is still
   reported, which is the case the sentence exists for.
2. **A refusal the engine diagnosed was printed twice.** Both engines build
   their errors as `new CaptureError(detail, { detail })`, so message and detail
   are the same string, and `describeCaptureFailure` appended one to the other:
   *"display 99 does not exist: this machine reports 1 display(s): display 99
   does not exist: this machine reports 1 display(s)"*. The detail is now added
   only when it says something the message does not already carry, which keeps
   the two fields useful for the failures where they differ.

Both are shared with macOS — the same two behaviours were wrong there, for the
same reasons, and a macOS burst that lands 5ms over its interval was being told
the same untruth. Fixing them in the shared layer keeps the platforms aligned
rather than aligning Windows to a macOS bug.

One consequence worth recording, because it cost a restart to learn: the running
harness holds the modules it booted with, so a fix to a message lands on the
next start, not the next call. The live session above showed the old text until
the harness was restarted again.

### 8.3 A transition that runs once, watched from its start to its end

The two hardest questions about a component animation are *when does it begin*
and *when is it over*, and neither is answerable from the call. The first is why
the burst can wait for the picture to move (section 8.1 measured that path); the
second is why it ends when the picture settles. Both were verified against an
animation whose truth is known exactly: a 60px block crossing 660px in 300ms,
drawn by a separate process, triggered 2.5 seconds after the call was issued so
that the watcher was certainly already waiting.

| run | frames | spacing | `endedBecause` | block x, in order |
| --- | --- | --- | --- | --- |
| `interval_ms: 40, wait_for_change: true` | 7 | 56ms | `still` | 553 → 638 → 812 → 982 → 1037, 1037, 1037 |
| the same, plus `until_still: false` | 10 | 47ms | `frames` | 10 identical frames |

The first run passed **no ending parameter at all**: it began on the transition
because it was watching for one, took four frames that read the movement, saw
two still frames after it, and ended itself at 2.6s with six frames of its cap
unused. The second kept taking frames after the motion had stopped, which is what
a caller who asked for a window rather than an event wants, and it is the reason
the opt-out exists.

The frames were read back from their own pixels rather than from the engine's
account of them — the block's horizontal centre recovered per frame, which is how
"four frames of motion" is a measurement and not a claim.

One testing trap is worth recording, because it produced a confident wrong
answer first: the animation window never appeared, so the burst watched an empty
region and reported a still screen. The cause was launching the animation process
with `-WindowStyle Hidden` or `windowsHide: true` — Windows applies that to the
process's **first** `ShowWindow` call, which is the one that shows the form,
whatever the form asks for. Starting it without those flags made it appear. A
region that is off by even a little is otherwise a silent failure mode: the
frames that come back are real, and they show nothing.

### 8.4 The budget a wait and a capture share

A wait is dead time by construction, so it and the capture after it draw on one
budget: `timeout_ms` covers the whole call, and the platform is given what the
wait did not spend. The default was raised to five minutes for it, because the
worst case the tool advertises has to fit inside one — a 30s wait for a user to
trigger something, and then a burst that may legitimately run for minutes under
`until_still` with a long interval. A budget that a wait could exhaust would turn
"watch this animation" into "return nothing", and the failure would look like the
animation's fault.

Both halves were exercised together: the runs in 8.3 waited 1.2-2.5s and then
captured, and the wait timeout was set to 12s against a 30s default, which is the
parameter that has to cover the user reading a message before triggering
anything.

## 9. What was reasoned about but not executed

- **The client-side settings surface.** None is shipped in this version, so
  there is no browser UI to verify.
- **A model without image input.** Refused up front; verified by self-test with
  a stubbed route, not against a real text-only model.
- **Retention over a long run.** The rule and its file-level behaviour are
  tested; that the default cap of 50 is the right number is a judgement, not a
  measurement.
- **`window` and `select` on macOS.** Interactive by design, so no automated
  case can complete them; the flag mapping is asserted and nothing more is
  claimed. On Windows `window` is not interactive and is exercised for real,
  while `select` is refused by design.
- **Attachment-store rejection.** `saveImage` can refuse an image that exceeds
  the deployment's limits (8192 px per side, 64 megapixels, 20 MB by default).
  A single display cannot reach those — the default capture is one display
  precisely so it is one file — so the store's errors are left to propagate
  rather than translated into advice for a case current hardware does not
  produce. Worth revisiting if a display larger than 8K ships.
