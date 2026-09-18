# Settings, and where they live

This plugin has one settings namespace, `screen-eye`, and three layers decide
what a value actually is. In order, each overriding the one before it:

| layer | where it comes from | who edits it |
| --- | --- | --- |
| schema defaults | `Config` in `index.mjs` | the code |
| the mount entry | the plugin's own entry in the bundle patch (`cordis.patch.yml`) | whoever composed the deployment |
| the user document | `~/.dsh/settings.yaml`, under `screen-eye:` | the settings page, or the file |

The entry is the **base**, not a default that disappears: a deployment with no
settings document runs on exactly what it mounted with, and a field a user
clears falls back to the entry rather than to nothing. That is why the plugin
uses `settings.installSection` rather than registering a namespace outright —
the composition entry stays the fallback.

Edits take effect **on the next call**, without a restart. The tools read their
settings through a reader (`readSettings`) rather than capturing them at mount,
which is the whole point of the section: a setting that only applied after a
restart would make the settings page a decoration.

## The page

`Settings → Screen Eye` — a section of its own in the settings navigation, with
an eye on the row and the controls on the right.

| field | kind | what it decides |
| --- | --- | --- |
| `locale` | `en` / `zh` | the language of the Screen Recording onboarding the tools return |
| `outputDir` | path | where captured PNGs are written; empty uses the default |
| `keepRecent` | whole number | how many of the newest captures stay on disk; `0` keeps everything |
| `timeoutMs` | whole number | the budget for one call, wait included; a single call may raise it further, up to 900000 |
| `maxDimension` | whole number | a capture with a longer side is refused with its size named, not resized |
| `requireImageCapableModel` | switch | refuse a capture when the calling model declares no image input |
| `deleteAfterCommit` | switch | delete the PNG once the image is in the attachment store |
| `announceCapability` | switch | put the standing line in the system prompt, and register the `screen-eye` skill |

`announceCapability` is the one field here that is not about the capture. It
decides whether the model is *told* it can look at the screen, and it exists
because the plugin shipped without that and measured the cost: across sixty local
sessions, fifty-four mention `screenshot` exactly once and always in the Web
surface's "no implicit DOM, route, or screenshot context", while nine sessions
ever called the tool — six of them spent building or testing this plugin. A
schema says how to call a tool; nothing reads it while the model is still
deciding what to do. README's
[Telling the model it has eyes](../README.md#telling-the-model-it-has-eyes) has
the wording and the four decisions behind it.

Two details of the switch are worth knowing before flipping it:

- **Turning it off leaves the tools alone.** The capability stays; only the
  announcement goes. Nothing about capture, retention or permission changes.
- **The line comes back without a restart; the skill does not.** The section's
  text is evaluated at each assembly, so an edit applies to the next request.
  A skill registration cannot be walked back once made, so whether the skill
  exists is decided by the setting as it stood when the plugin mounted — turn it
  off and back on, and the line returns while the skill stays gone until the
  next mount.

Two defaults are worth knowing because they are the ones a user meets first:

- **`outputDir`** is `<pictures>/Screen Eye` — the system pictures folder
  (`~/Pictures` on both platforms), under a folder of this plugin's own so that
  fifty screenshots do not land loose among the user's photographs. A machine
  that has moved or renamed its pictures folder keeps the default until someone
  points the field at the real path; finding a relocated folder would mean
  reading the registry on every call, and the honest version of that is a field
  the user can set.
- **`maxDimension`** is **4096**, not the store's 8192. 8192 is the limit for a
  request holding a handful of images; the moment one holds fifteen or more, the
  provider's per-image side limit drops to 4096 — and a burst can hold hundreds.
  The consequence is worth stating plainly: **a display wider or taller than
  4096 px cannot be captured whole at this default** — a 5K panel, say — and the
  fix is to raise this field, not to capture something that comes back refused.

Edits are **staged and written on save**. Every settings write is a durable,
revision-fenced document mutation, so a control that committed as it settled
would turn one keystroke into a write the user never asked for and could not
preview. A field the user has changed carries a badge and a **Reset** that drops
their override, letting it fall back to what the plugin was mounted with. A
namespace this deployment does not serve renders nothing at all, rather than a
page of controls that could never save.

## How the two halves find each other

The Host half registers the namespace `screen-eye`. The browser half binds that
same namespace through `ctx.settingsScope` and registers a `settings.section`
whose `id` is the namespace. Nothing else links them: a typo on either side is a
page that renders nothing, with no error anywhere to say why, so a self-test
reads both and asserts they match (`SETTINGS_NAMESPACE`).

Three constraints shape the browser half, and all three are the platform's
rather than this plugin's:

- **The harness's own components cannot be imported.** The client
  bundle-purity gate forbids cross-plugin value imports, so `client/client.js`
  draws its own chrome — the same design tokens (`--dsw-alias-*`), the same
  measurements, its own class names, and its own dictionaries registered under
  its own locale namespace.
- **A section cannot declare an icon.** The `settings.section` contract projects
  `id`, `order` and `label` and nothing else, and the shell picks a row's glyph
  from a closed list of built-in ids: anything it does not recognise gets the
  generic gear. So the row is claimed after it mounts — the plugin marks the nav
  button carrying its own label, and a stylesheet hides the gear and draws an
  eye in its place as a `currentColor` mask, which keeps the shell's hover and
  active colours and its 16px rhythm. The marker is removed on disposal, so the
  adaptation is HMR-safe, and it depends on nothing but the label the plugin
  itself supplied. `dsh-better-sidebar` closes the same gap the same way; the day
  the contract grows an icon field, this becomes one line shorter.
- **There is no build step.** A client half is a classic script that registers
  itself on `window.__ModuleLoader__.load` and returns a plugin face, which is
  small enough to write directly: the elements are `React.createElement` calls
  and the only module required is the shared `react`. A bundler would buy JSX
  and dependency resolution — neither of which this file needs — at the cost of
  an artifact that has to be rebuilt and kept in step with a plugin that
  otherwise has no build at all.

## When the section does not appear

Both halves fail in the same silent shape, and this page is where it is noticed:
a client half whose declared modules do not resolve, or whose cordis services
the running shell does not provide, is simply never applied. No error is raised,
no row is drawn, and a comparison of the two declarations cannot tell the two
causes apart — one is fixed in `package.json`, the other in the module's own
`inject` list. The answer has to come from the browser, so the plugin keeps one
line for exactly this question, off by default because a healthy mount is not
news:

```js
localStorage.screenEyeDiagnostics = '1'   // then reload the page
// [screen-eye] loaded · slots=object locale=object settingsScope=object
localStorage.removeItem('screenEyeDiagnostics')   // take it away again
```

Read it as two answers:

- **The line is absent.** `apply` never ran. Either the bundle never
  materialised — every `dsh.client.inject` entry has to be a client module that
  exists in this deployment, and a phantom id waits forever without a word —
  or one of the services in the module's own `inject` list is not provided.
- **The line is there.** The mount is healthy; the three services are the ones
  the page mounts with. Anything still missing is a rendering problem rather
  than a wiring one.

It is a browser switch rather than a plugin setting: it lives in the origin's
local storage and never in `~/.dsh/settings.yaml`, because it reports on the
mount instead of configuring the capture.

## Editing the file by hand

The page is a convenience over the document, not a gate in front of it:

```yaml
screen-eye:
  locale: zh
  keepRecent: 20
  maxDimension: 5120
```

Anything left out falls back to the entry, and a hand-edited section the schema
rejects keeps the namespace's last good value and warns rather than stranding the
running plugin. Deleting the section entirely returns the plugin to what it was
mounted with.
