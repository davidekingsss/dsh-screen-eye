# Watching something move

A still capture answers "what is on screen". It cannot answer "what just
happened" — a spinner, an animation, a dialog appearing, a progress bar. This
page records what was tried for that, what the harness actually does with the
obvious answer, and why the tool works the way it does.

## An animated GIF cannot work, and the reason is not the provider

The DeepSeek API accepts GIF as an input format, so "can it read a GIF" looks
like the question. It is not. **By the time an image reaches the provider from
this harness, an animated GIF is already a single frame**, and it was reduced
in the attachment store, before any request was built.

`@deepseek-ai/dsh-attachment-local` normalises every stored image with sharp.
It reads the frame count — `animated: (metadata.pages ?? 1) > 1` — and then
uses that fact for one thing only: forcing the image down the re-encode path,
because GIF is excluded from pass-through outright. The re-encode pipeline is
constructed without `animated: true`, so sharp decodes the first frame; the
encoder ladder has WebP and JPEG as its only outputs and never writes GIF; and
the result is asserted to be single-frame before it is stored.

The fact is not merely dropped at one step, either — it does not exist at the
type level. Neither `ImageAttachmentRef` nor the model-facing `ImageBlock`
carries anything about frames, so no later stage could preserve it even if it
wanted to.

This was verified rather than argued: a real three-frame GIF put through the
package's own exported normalisation and request-projection functions came out
as a single-frame WebP, and again as a single-frame WebP at the request layer.
The model is told it received `image/webp`, which is true and also tells it
nothing about the frames that are missing.

Recording video and converting it is not a way around this either. The obvious
local transcoder on the development machine could not run at all — its
Homebrew build links a version of x265 that is not the one installed — and the
only working `ffmpeg` was one bundled inside an unrelated third-party
application. Depending on that for a plugin's core behaviour is not a
dependency worth having, and it would still end at the same single frame.

## What the tool does instead

`frames` above 1 takes that many captures, spaced by `interval_ms`, and returns
them all in one call as separate images. It is better than a GIF here, not a
substitute for one:

- **Every frame is seen.** The harness projects each image to a route-level
  budget of about 640,000 pixels — measured, not assumed — so six frames arrive
  as six full-detail images rather than as six slivers of one.
- **The frame count is exact.** `screencapture`'s video mode is variable-frame-
  rate: it drops duplicate frames, so a two-second recording of a still screen
  yields six frames, not twenty. Sequential captures yield what was asked for.
- **No transcoder, no intermediate format.** Frames are the same PNG the single
  capture produces, so nothing depends on a third-party binary, and every frame
  keeps the coordinate mapping to the screen that `region` relies on.
- **Full colour.** A GIF's 256-colour palette blurs small text; these do not.

The costs are real and worth stating: each frame is one image against the
harness's 20-images-per-message budget, which is why a burst is capped at ten,
and each frame costs what a capture costs, about 380 tokens.

## Using it well

A burst over the whole screen is usually wasted. With the budget being fixed
per image, a region that fills it carries far more than a region seen inside a
full-screen capture — measured at a factor of **3.3 in linear detail for the
same token cost**. So the useful shape is "watch *this* area for a second"
rather than "watch everything":

```
screenshot  mode=region  region=<the area>  frames=6  interval_ms=200
```

`interval_ms` is a target rather than a promise. A capture costs about 170ms,
so a smaller gap cannot be met; the envelope reports the spacing actually
achieved instead of repeating the request back.
