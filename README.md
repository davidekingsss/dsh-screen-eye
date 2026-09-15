# dsh-screen-eye

An autonomous eye for DeepSeek Harness on macOS: the agent captures the screen
and receives the picture **in the same tool call**, so it can look at a running
app, a dialog, an error or its own UI work without asking you for a screenshot.

macOS only. No native build step, no bundled binary, no dependencies.

## What it adds

Two model-callable tools:

| Tool | What it does |
|---|---|
| `screenshot` | Captures the screen and returns the image itself, as an `image` content block the model can see. |
| `screen_permission` | Reports whether macOS currently allows this process to capture, and opens the exact System Settings pane when it does not. |

`mode` selects what is captured: `screen` (default, the main display), `display`
(one display, by index), `region` (a rectangle, whose origin may be negative so
a monitor placed to the left of or above the main one is reachable), `displays`
(which captures nothing and lists the connected screens with the index `display`
expects), or the interactive `window` / `select`, which wait for the user to
click a window or drag a rectangle.

Set `frames` above 1 and the call takes that many captures `interval_ms` apart
and returns them all, which is how something that changes over time can be
seen. This is deliberately not a GIF: the harness stores images single-frame,
so an animated GIF arrives as its first frame.

Both knobs are yours to set, and the useful direction is not always "finer".
How fast frames can be taken depends on the area — 155ms for a whole 4K screen
but 56ms for a 1200x800 region — so a short component animation is resolved by
capturing the small area it happens in, not by asking for a finer interval over
everything. The reply reports the spacing actually achieved, and says so when
the request could not be met. [`docs/motion.md`](docs/motion.md) has the
measurements and the reasoning.

Every other call returns **exactly one image**. That is a deliberate constraint rather
than a limitation of the system: `screencapture` writes *one file per screen*,
so an unqualified capture on a multi-display Mac would produce several files
while this pipeline resolves and reads a single path — leaving the others behind
under names nothing here chose. The default is therefore pinned to one display,
and `display` selects another.

## Why this plugin exists

Most screenshot tooling assumes the hard part is capturing pixels. On macOS the
hard part is **permission**, and it fails in a way that looks like a bug:

```
screencapture: could not create image from display
```

macOS gates screen capture behind the Screen Recording permission, keyed to the
**responsible process** — the application macOS holds accountable for a whole
process tree. A DeepSeek Harness host is often not a normal GUI application.
The in-app plugin market restarts the host through a detached helper, so the
host is reparented to `launchd` and has no application anywhere above it. When
such a process asks for the screen, macOS cannot attribute the request to
anything the user could grant, so it **denies it without ever showing a
prompt**.

The permission cannot be granted programmatically: the TCC databases are
SIP-protected, `tccutil` only resets, and `CGRequestScreenCaptureAccess`
refuses to prompt for a process that is not an app bundle. So this plugin does
what is actually possible:

- it **detects** the denial by attempting a real capture and classifying the
  result, rather than guessing;
- it **computes the exact executable** that must be granted, from the running
  host, instead of describing it generically;
- it **opens the exact settings pane** on request;
- and it returns those steps as the tool result, so the agent can hand you a
  fix rather than a stack trace.

## Install

```sh
dsh plugin --profile web add github:davidekingsss/dsh-screen-eye
# then restart dsh
```

From a local checkout, instead of a published source:

```sh
dsh plugin --profile web add link:/path/to/dsh-screen-eye
```

The plugin has no build step and no dependencies, so nothing is compiled at
install time.

## Grant Screen Recording (once)

Call `screenshot` once. If permission is missing, the result tells you exactly
what to do, and `screen_permission` with `action: "open_settings"` opens the
pane for you. In short:

1. Open **System Settings → Privacy & Security → Screen & System Audio
   Recording**.
2. Click **+**, press **⌘⇧G**, paste the path the tool reported (normally the
   `node` binary running the harness), and select it.
3. Turn its switch on.

No restart is needed — the grant applies to the next capture.

If you start the harness from a terminal, granting that terminal application
instead has the same effect.

> macOS may periodically ask you to re-confirm this permission. Re-enabling the
> same switch is enough.

## Configuration

All keys are optional.

| Key | Default | Meaning |
|---|---|---|
| `outputDir` | `<DSH home>/screen-eye` | Where captured PNGs are written. |
| `locale` | `en` | Language of the onboarding text: `en` or `zh`. |
| `timeoutMs` | `120000` | Cooperative budget for one capture. |
| `frames` / `interval_ms` | `1` / `200` | Frames per call and the target gap between them. At most 10 frames, because they share the harness's per-message image budget. |
| `maxDimension` | `8192` | Largest side, in pixels, a capture may have. The provider caps an image side at 8192 (4096 once a request carries fifteen or more images) and the attachment store caps it at 8192 as well; a single display never reaches either. A capture over the cap is refused with its size named. |
| `keepRecent` | `50` | How many of the newest captures to keep in `outputDir`. A capture is a few-megabyte PNG and an agent using its eyes takes many, so the directory is bounded by default. `0` keeps everything. |
| `requireImageCapableModel` | `true` | Refuse a capture when the calling model declares no image input, instead of returning a picture it cannot see. |
| `deleteAfterCommit` | `false` | Delete the PNG once it is committed to the attachment store. Off by default, so the returned path stays re-readable. |

Retention only ever removes files **this plugin wrote**: regular files, direct
children of `outputDir`, whose names match the exact shape it generates
(`shot-<timestamp>-<suffix>.png`). It is never recursive, it never touches
another naming scheme, and it never removes the capture it just returned.

```yaml
# cordis.patch.yml
- insert:
    - id: screen-eye
      name: dsh-screen-eye
      config:
        locale: zh
        outputDir: /Users/me/Pictures/agent-shots
        keepRecent: 200
```

## How it works

```
screenshot tool ──▶ lib/capture.mjs ──▶ /usr/sbin/screencapture ──▶ PNG
                       │
                       └──▶ attachments.saveImage() ──▶ image content block ──▶ model
```

Captures are **not** resized to fit `maxDimension`, and the cap is deliberately
not set lower. Both choices come from the same measurement: the harness projects
every image to a route-level pixel budget before the model sees it — 640,000
pixels by default, about 1066x600 for a 16:9 screen — so a capture from a 4K, 5K,
6K or 8K display arrives as the *same* image. Below that budget a smaller cap
cannot save a token, and resizing here would insert one more scale between what
the model measures in the image and the screen coordinates `region` expects,
which is the mapping the zoom workflow depends on.

The capture shells out to the system `screencapture(1)` rather than shipping a
private helper. That choice is deliberate: `screencapture` needs no compiled
artefact, is Apple-signed, and already uses ScreenCaptureKit internally on
current macOS. A private helper would instead require per-architecture builds
and an ad-hoc signature whose hash changes on every rebuild — and a changed
hash silently invalidates the user's Screen Recording grant.

The image reaches the model through the same attachment path the built-in
`read_image` tool uses, so the value is validated, downscaled and replayed
exactly like any other image in the session.

## Platform support

macOS only, enforced in two places: the bundle patch carries
`disabled: !!js process.platform !== 'darwin'`, so on another platform the
module is never imported, and `apply()` re-checks so a direct mount cannot
register capture tools that have no engine.

Windows has no equivalent permission gate — any process may capture the screen,
so a Windows engine would need no onboarding flow at all. It is not included
because it cannot be tested from this repository's development environment, and
claiming untested platform support would be worse than declaring the limit.
[`docs/windows.md`](docs/windows.md) records what was determined about it, the
hazard a naive engine would hit, and where the seam is if you want to add it.

## Requirements

- macOS with the harness's Node runtime (the capture path needs no extra
  package).
- A model route that declares image input. With `requireImageCapableModel`
  left at its default, a text-only route is refused up front with a message
  naming the model, instead of silently capturing something the model cannot
  see.

## Development

```sh
npm install
node test/selftest.mjs
```

The suite runs without a harness: the logic modules are imported directly and
the tool definitions are exercised through a stubbed context, so it works on a
machine that has never seen the harness — which is also what CI does. Cases
that capture for real run only when the machine already has Screen Recording
permission, so the suite stays green before the grant too.

The three `@deepseek-ai/*` packages the plugin imports are pinned exactly in
`devDependencies`, and that is deliberate: they publish the current line under
the `next` dist-tag while their `latest` tag still points at a much older
release, so an unpinned install resolves to the old one and the import fails.

[`docs/verification.md`](docs/verification.md) records what has actually been
run — the self-test, loader acceptance in an isolated profile, and one
end-to-end agent turn — and what each result does and does not prove.

## License

MIT
