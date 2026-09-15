# Verification

What has actually been run, and what each result does and does not prove. The
point of writing it down is that "it works" is a claim, and a reader should be
able to tell which parts of it were executed and which were only reasoned
about.

## 1. Self-test — `node test/selftest.mjs`

30 cases, all passing. They run without a harness: the logic modules are
imported directly and the tool definitions are exercised through a stubbed
context.

What they cover:

- argument validation, including the cases that must be **rejected** rather
  than repaired — malformed regions, a region passed to a non-region mode, a
  zero or fractional display index;
- the mapping from each mode onto `screencapture` flags, and that every mode
  produces PNG so the declared media type is true;
- output-path rules: absolute and `.png` only, and 200 generated names are
  distinct (two captures in the same second must not overwrite each other);
- that the schemastery defaults and the module fallbacks agree, because they
  are applied on different paths and a silent drift would make behaviour
  depend on how the plugin loaded;
- the image content blocks, including the downscale multiplier;
- permission diagnosis: a TCC denial is classified separately from every other
  failure, and the guidance names the exact executable to grant;
- tool wiring: `apply()` registers both tools on darwin and **registers
  nothing** on a non-darwin host;
- the bundle patch carries the platform gate, and the package stays
  installable (`dsh.bundle` present, every required file in `files`).

Cases that capture for real run only when the machine already has Screen
Recording permission, so the suite is green before the grant as well. On CI
they skip.

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

## 4. What was reasoned about but not executed

- **Windows.** No capture engine is shipped, so nothing about Windows was run.
  The platform registry in `lib/capture.mjs` is the seam a Windows engine would
  occupy.
- **The client-side settings surface.** None is shipped in this version, so
  there is no browser UI to verify.
- **A model without image input.** Refused up front; verified by self-test with
  a stubbed route, not against a real text-only model.
