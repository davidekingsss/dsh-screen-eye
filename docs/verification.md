# Verification

What has actually been run, and what each result does and does not prove. The
point of writing it down is that "it works" is a claim, and a reader should be
able to tell which parts of it were executed and which were only reasoned
about.

## 1. Self-test — `node test/selftest.mjs`

57 cases, all passing. They run without a harness: the logic modules are
imported directly and the tool definitions are exercised through a stubbed
context.

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
- tool wiring: `apply()` registers both tools on darwin and **registers
  nothing** on a non-darwin host; that a tool-name collision leaves the host
  running and the other tool registered; and that the collision is then
  *discoverable* — `screen_permission` reports it, and its render drops the
  clean-bill-of-health sentence rather than claiming a working screenshot tool
  the plugin's own report contradicts;
- the bundle patch carries the platform gate, and the package stays
  installable (`dsh.bundle` present, every required file in `files`).

Cases that capture for real run only when the machine already has Screen
Recording permission, so the suite is green before the grant as well. On CI
they skip.

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
  with `disabled: !!js process.platform !== 'darwin'`, which is the gate
  surviving composition;
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

## 4. What the plugin's logs are worth — a canary

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

## 5. What was reasoned about but not executed

- **Multi-display behaviour.** The machine this was developed on has one
  display, so no multi-display case was ever run. What was done instead:
  `screencapture`'s manual was read rather than assumed, and it says the output
  argument takes *one file per screen* — which is why the default mode now
  passes `-m` and is documented as the main display, so that one call cannot
  produce files this pipeline does not resolve and read. Negative region
  coordinates were verified to be *accepted* by the binary, but a region that
  actually intersects a second display could not be captured here.
- **Windows.** No capture engine is shipped, so nothing about Windows was run.
  [`windows.md`](windows.md) records the assessment, including the parts of it
  that are hypotheses rather than findings.
- **The client-side settings surface.** None is shipped in this version, so
  there is no browser UI to verify.
- **A model without image input.** Refused up front; verified by self-test with
  a stubbed route, not against a real text-only model.
- **Retention over a long run.** The rule and its file-level behaviour are
  tested; that the default cap of 50 is the right number is a judgement, not a
  measurement.
- **`window` and `select`.** Interactive by design, so no automated case can
  complete them; the flag mapping is asserted and nothing more is claimed.
- **Attachment-store rejection.** `saveImage` can refuse an image that exceeds
  the deployment's limits (8192 px per side, 64 megapixels, 20 MB by default).
  A single display cannot reach those — the default capture is one display
  precisely so it is one file — so the store's errors are left to propagate
  rather than translated into advice for a case current hardware does not
  produce. Worth revisiting if a display larger than 8K ships.
