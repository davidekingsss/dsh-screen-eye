# Windows

This plugin is macOS-only. Windows is the obvious next platform, so this page
records what was actually determined about it: what the port involves, what
differs, and why nothing has been shipped.

## What is platform-specific, and what is not

The plugin is a platform-neutral core with an operating-system layer behind a
seam. Measured by counting macOS references per module, the core is the
majority: mode validation, burst planning, the frame interval as a cost lever,
image content blocks, the attachment commit, retention, naming and the output
contract contain no macOS reference at all.

Everything that does depend on the system is reachable through exactly one
module, `lib/platform.mjs`, which selects an implementation by
`process.platform`. The tool layer imports that and nothing else — a self-test
case walks the real import graph and fails if any OS-specific module becomes
reachable from outside the seam, because a seam survives exactly until the next
convenient shortcut.

The macOS implementation is `lib/platform/darwin.mjs`, and it provides three
things:

| member | macOS |
| --- | --- |
| `capture(plan, outputPath, options)` | `screencapture` and its flags |
| `listDisplays(options)` | `system_profiler SPDisplaysDataType` |
| `permission` | the Screen Recording consent model |

## There is no equivalent permission gate

The reason the macOS half is mostly about permission is that macOS gates screen
capture behind a user-granted, per-responsible-process consent, and denies
silently when it cannot attribute the request — see `lib/permission.mjs`.
Windows has nothing corresponding to that for a normal desktop process.
`BitBlt` against the desktop device context, or `PrintWindow` against a window
handle, needs no consent, no prompt and no entitlement.

So the contract allows `permission: null`, and a platform that declares it
registers no `screen_permission` tool at all: there would be nothing for it to
report, and offering the model a question with no answer is worse than not
offering it. That is the one place where the two platforms' tool surfaces
legitimately differ.

This was established by reading the platform's model, not by running anything on
Windows. Treat it as a starting hypothesis to check on the first real machine,
not as a verified fact.

## What a Windows implementation would have to do

- **Capture** through PowerShell, since the alternative is a compiled helper and
  shipping binaries is exactly what the macOS implementation avoids.
- **Map the four modes**, which do not correspond one-to-one: `screen` and
  `display` are `CopyFromScreen` over a virtual-screen rectangle, `region` is
  the same over a sub-rectangle, and `window` has no interactive equivalent —
  there is no system-provided "click a window to capture it" affordance, so it
  would have to enumerate windows itself and take a handle or pick by z-order.
  `select` likewise has no system region picker to lean on. Those two are design
  work, not typing.
- **Enumerate displays**, reporting them main-first and indexed from 1 so the
  index can be handed back to `capture` as `plan.display`. On macOS the proof
  that this matters is that `-D 2` really does select the second screen; the
  Windows equivalent needs the same check.
- **Declare `permission: null`**, or something else if the session model turns
  out to need reporting after all.

## One real hazard, and it is not a permission

A Windows process that is not attached to the interactive session cannot capture
it. A harness running as a service, or under a different session, would produce
a black frame rather than an error — the failure looks like a successful capture
of a black screen. That is the same *class* of problem as the macOS one, with a
different cause, and it is worth stating because the naive engine would report
it as success.

## Why nothing is shipped

The repository's development environment is macOS. A Windows engine could be
written here and could not be run here, and every claim in this project's
description is meant to survive being checked against the code and against
behaviour. Shipping an untested engine would put a claim in the README that
nobody has falsified — which is the failure mode the market's review process
exists to catch, and the one this project has been careful about elsewhere.

The niche is also not empty: several plugins capture the Windows screen and were
developed and tested there. Adding an untested fourth would not serve Windows
users better than the tested ones already available.

## If you want to add it

1. Write `lib/platform/win32.mjs` exporting an object with `id`, `capture`,
   `listDisplays` and `permission`, per the contract documented in
   `lib/platform.mjs`. That file is the whole specification, and
   `lib/platform/darwin.mjs` is a worked example.
2. Register it in the `PLATFORMS` map in `lib/platform.mjs`. That is what makes
   the runtime gate open — `index.mjs` asks the registry rather than naming a
   platform, so there is nothing else to enable.
3. Update the `disabled: !!js` expression in `cordis.patch.yml` to match. This
   is the one place that has to repeat the answer, because the loader evaluates
   it without access to the module, and a self-test case evaluates it against
   the registry on every run so the two cannot drift.
4. Add the platform to the description and the README, and record in
   `docs/verification.md` what was run on which machine — including, if it
   applies, the session-isolation hazard above.

Nothing in steps 1–4 can be checked from macOS. What can be — the seam itself,
the mode and burst contract, the content blocks, retention, the output shapes —
is covered by cases that run anywhere, which is what a port would be built on.
