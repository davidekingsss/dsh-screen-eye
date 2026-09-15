# Windows

This plugin is macOS-only. Windows is the obvious next platform, so this page
records what was actually determined about it: what would be involved, what
would be different, and why nothing was shipped.

## There is no equivalent permission gate

The reason the macOS half of this plugin is mostly about permission is that
macOS gates screen capture behind a user-granted, per-responsible-process
consent, and denies silently when it cannot attribute the request — see
`lib/permission.mjs`. Windows has nothing corresponding to that for a normal
desktop process. `BitBlt` against the desktop device context, or
`PrintWindow` against a window handle, needs no consent, no prompt and no
entitlement.

So the onboarding flow — `screen_permission`, the computed grant target, the
deep link into System Settings — has no Windows counterpart to build. A Windows
engine would be capture and nothing else.

That is the whole of the good news, and it is worth being precise about the
limit of this claim: it was established by reading the platform's model, not
by running anything on Windows. It should be treated as a starting hypothesis
to check on the first real machine, not as a verified fact.

## What the engine would do

`lib/capture.mjs` already has the seam: engines are held in a registry keyed by
`process.platform`, and `captureScreen` dispatches through it. Everything above
that seam — argument validation, the output path, the attachment commit, image
content blocks, retention — is platform-neutral and would not change.

A Windows engine would need to:

- run a capture through PowerShell, since the alternative is a compiled helper
  and shipping binaries is exactly what the macOS engine avoids;
- map the same four modes onto Win32 primitives, which do not correspond
  one-to-one: `screen` and `display` are `CopyFromScreen` over a virtual-screen
  rectangle, `region` is the same over a sub-rectangle, and `window` has no
  interactive equivalent — there is no system-provided "click a window to
  capture it" affordance, so it would have to enumerate windows itself and
  either take a handle argument or pick by z-order;
- decide what `select` means without a system region-picker overlay.

Those three are design work, not typing, and they are the reason a Windows
engine is not a mechanical port.

## One real hazard, and it is not a permission

A Windows process that is not attached to the interactive session cannot
capture it. A harness running as a service, or under a different session, would
produce a black frame rather than an error — the failure looks like a
successful capture of a black screen. That is the same *class* of problem as
the macOS one (a capture that fails for a reason the tool did not cause) with a
different cause, and it is worth stating because the naive engine would report
it as success.

## Why nothing is shipped

The repository's development environment is macOS. A Windows engine could be
written here and could not be run here, and every claim in this project's
description is meant to survive being checked against the code and against
behaviour. Shipping an untested engine would put a claim in the README that
nobody has falsified — which is the failure mode the market's review process
exists to catch, and the one this project has been careful about elsewhere.

The niche is also not empty: several plugins capture the Windows screen and
were developed and tested there. Adding an untested fourth would not serve
Windows users better than the tested ones already available.

## If you want to add it

The work is self-contained, which is the point of the registry seam:

1. Add a `captureWindows(plan, outputPath, options)` function in
   `lib/capture.mjs` and register it under `'win32'`.
2. Extend `screencaptureArgs`'s counterpart for PowerShell. Keep the mode
   validation in `planCapture` unchanged — it is already platform-neutral.
3. Drop the `disabled: !!js process.platform !== 'darwin'` gate in
   `cordis.patch.yml`, and the `process.platform` check in `index.mjs`, to
   whatever set of platforms now has an engine.
4. Add the platform to the description and the README, and record in
   `docs/verification.md` what was run on which machine — including, if it
   applies, the session-isolation hazard above.

The self-test is written to skip its capture cases on a platform with no
engine, so it will keep passing while the engine is added.
