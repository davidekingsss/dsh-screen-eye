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

## The card

`Settings → Plugins → Screen Eye` shows one card per field:

| field | kind | what it decides |
| --- | --- | --- |
| `locale` | `en` / `zh` | the language of the Screen Recording onboarding the tools return |
| `outputDir` | path | where captured PNGs are written; empty keeps the default under the harness home |
| `keepRecent` | whole number | how many of the newest captures stay on disk; `0` keeps everything |
| `timeoutMs` | whole number | the budget for one call, wait included; a single call may raise it further, up to 900000 |
| `maxDimension` | whole number | a capture with a longer side is refused with its size named, not resized |
| `requireImageCapableModel` | switch | refuse a capture when the calling model declares no image input |
| `deleteAfterCommit` | switch | delete the PNG once the image is in the attachment store |

Edits are **staged and written on save**. Every settings write is a durable,
revision-fenced document mutation, so a control that committed as it settled
would turn one keystroke into a write the user never asked for and could not
preview. A field the user has changed carries a badge and a **Reset** that drops
their override, letting it fall back to what the plugin was mounted with. A
namespace this deployment does not serve renders nothing at all, rather than a
disabled card the user cannot act on.

## How the two halves find each other

The Host half registers the namespace `screen-eye`. The browser half registers a
card into the settings shell's `settings.plugin.item` slot **keyed by the same
string**, and the shell pairs them without knowing what either means — the
contract exists precisely so a plugin distributed outside the harness repository
can contribute a card. A typo in either place is a card that never appears, with
no error anywhere to say why, so a self-test reads both and asserts they match
(`SETTINGS_NAMESPACE`).

Two constraints shape the browser half, and both are the platform's rather than
this plugin's:

- **The harness's own card components cannot be imported.** The client
  bundle-purity gate forbids cross-plugin value imports, and the official
  `PluginCard` is not addressable anyway — its copy keys are a closed union of
  the harness's own plugin names. So `client/client.js` draws its own chrome,
  using the same design tokens (`--dsw-alias-*`) and the same measurements, with
  its own class names and its own registered dictionaries.
- **There is no build step.** A client half is a classic script that registers
  itself on `window.__ModuleLoader__.load` and returns a plugin face, which is
  small enough to write directly: the elements are `React.createElement` calls
  and the only module required is the shared `react`. A bundler would buy JSX
  and dependency resolution — neither of which this file needs — at the cost of
  an artifact that has to be rebuilt and kept in step with a plugin that
  otherwise has no build at all.

## Editing the file by hand

The card is a convenience over the document, not a gate in front of it:

```yaml
screen-eye:
  locale: zh
  keepRecent: 20
  timeoutMs: 600000
```

Anything left out falls back to the entry, and anything set to `null`… is not a
value the schema accepts, so a hand-edited section that fails validation keeps
the namespace's last good value and warns rather than stranding the running
plugin. Deleting the section entirely returns the plugin to what it was mounted
with.
