# Publishing pack — design

**Goal:** Make Framecast publish a real, findable, on-brand video — an AI-written
title, description and tags, an AI thumbnail carrying the channel's identity,
and the visibility and scheduling controls YouTube actually offers — with the
operator's single click still the thing that publishes it.

**Status:** Approved by the operator. Ready for an implementation plan.

## Why

A finished Framecast video today uploads as `UNLISTED`, titled with whatever the
operator typed when they created it, described with only a sources list and two
credit lines, carrying **no tags at all** and **no thumbnail**. YouTube generates
a thumbnail from a random frame of stock footage.

Every one of those is a discovery problem. Tags and description are how the
video is found; the thumbnail is most of whether it is clicked. A channel that
publishes daily with auto-generated frames and no tags is invisible regardless
of how good the video is.

Most of this is already modelled and unused:

- `Publication` carries `tags String[]`, `playlistId`, `visibility` and
  `scheduledFor`. `publish.service.ts` sets none of them and hard-codes
  `visibility: "UNLISTED"`.
- `Thumbnail` and `ThumbnailVersion` exist in full, with versioning, `prompt`,
  `provider` and `model` columns. Nothing writes to them.

The `UNLISTED` hard-code deserves its own note, because its stated reason has
expired. Its comment says the operator's ElevenLabs narration is on a free tier
with no commercial rights, so a public upload would be a licensing violation.
The operator has since moved to a paid tier. The constraint is gone; the
hard-code is not.

## Decisions taken

| Question | Decision |
|---|---|
| Scope | All four pieces in one spec: metadata, publish controls, thumbnails, channel identity |
| Thumbnail image source | AI Gateway image models, using the existing `AI_GATEWAY_API_KEY` |
| Thumbnail text | Composited by ffmpeg, never asked of the image model |
| Publish gate | Everything generates automatically; the operator's click still publishes |
| Channel identity scope | Thumbnail look, video style, voice, and script tone/niche |
| Logo | Generated once per channel, watermarked onto thumbnails |
| Channel avatar | Out of scope — the YouTube API cannot set it |

## Architecture

Five units, each independently testable, communicating through stored state
rather than direct calls:

1. **`ChannelBrand`** — the per-channel identity every other unit reads.
2. **`metadata.service.ts`** — title, description and tags from the script.
3. **`thumbnail.service.ts`** — the image, its text, and the logo watermark.
4. **`logo.service.ts`** — one-off logo generation per channel.
5. **Publish controls** — visibility, tags, playlist, and the thumbnail upload.

The pipeline gains two stages after `render`: `metadata` and `thumbnail`. Both
run automatically when a render succeeds, and a video reaches `READY` with
everything filled in. Nothing here publishes on its own.

## 1. ChannelBrand

A new model, one row per `Channel`, holding:

| Field | Purpose |
|---|---|
| `videoStyle Json?` | The `VideoStyle` object, merged over `DEFAULT_STYLE` |
| `logoPath String?` | Storage path of the chosen logo |
| `primaryColour`, `secondaryColour` | Thumbnail headline and accent |
| `headlineFont String?` | Thumbnail typeface; must exist in the worker image |
| `tone String?` | How the writing sounds — feeds script, title and description |
| `niche String?` | Subject and audience |
| `musicQuery String?` | What to search Jamendo for |

### Why a separate model rather than columns on `Channel`

`Channel` holds OAuth access and refresh tokens. It is the one row in this
schema whose accidental exposure is a security incident, and its own comment
says those tokens are "written by the server only and never selected into client
payloads." Brand fields are the opposite: read constantly, rendered in the UI,
edited by the operator. Keeping them in a separate table means the brand editor
never has to `select` from the row holding the tokens.

### Why `videoStyle` is nullable JSON

`src/lib/video-style.ts` was built with this exact move in mind — its doc
comment states that persisting per channel later is "a migration plus a loader,
with no rewrite of the render code." A null column merges to `DEFAULT_STYLE`,
so every existing channel renders precisely as it does today and the migration
needs no backfill.

### `musicQuery` fixes a real defect

`render.service.ts` currently searches Jamendo using the video's *title*, which
is why a test video titled "Ada Lovelace wrote the first program" found no
usable bed. A title is not a musical description. `musicQuery` is, and it
belongs to the channel rather than the video because a channel's music should
sound consistent.

## 2. Metadata

`metadata.service.ts` takes the active script plus the channel's `tone` and
`niche`, asks the gateway for a structured result, and writes it to **new
columns on the video**: `generatedTitle`, `generatedDescription` and
`tags String[]`.

### Why the video and not the publication

`Publication` already has all three columns, but that row is created inside
`publish()` as the concurrency claim — the `@unique` insert that stops two
callers uploading the same video twice. It cannot hold anything generated
before publishing. `publish()` therefore snapshots the video's metadata into
the `Publication`, which is what that model is already shaped for: a record of
what was actually sent.

### Limits are enforced here, not discovered at upload

YouTube rejects a title over 100 characters, a description over 5,000, and tags
whose combined length exceeds 500. A rejection arrives as a 400 after the video
bytes have already been uploaded — the most expensive possible moment to learn
the title was too long. The schema caps each field, and generation retries once
with the limits restated before giving up and truncating on a word boundary.

### Why new columns rather than overwriting `Video.title`

The operator typed `Video.title` when they created the video, and a model
should not silently overwrite something a human wrote. Separate columns
preserve the original by construction rather than by remembering to copy it:
the UI can show both, the operator can edit the generated one, and regenerating
never destroys anything.

`publish()` sends `generatedTitle ?? title`, so a video whose metadata
generation failed still publishes under the operator's own title instead of
being blocked. The same fallback applies to the description, which keeps
today's sources-and-credits behaviour when nothing was generated.

## 3. Thumbnail

`thumbnail.service.ts` produces a 1280×720 JPEG under YouTube's 2 MB cap, in
three steps:

1. **Prompt** — built from the script's opening (the hook is what the thumbnail
   must illustrate) plus the brand's tone and niche. Stored on
   `ThumbnailVersion.prompt`, so a good thumbnail can be reproduced.
2. **Image** — generated through the AI Gateway, model chosen by env
   (`AI_IMAGE_MODEL`) exactly as `AI_SCRIPT_MODEL` already works.
3. **Composite** — ffmpeg draws the headline in the brand's font and colour and
   watermarks the logo in a corner.

### Why the text is not generated

Image models render text unreliably: misspellings, invented glyphs, broken
kerning. Every AI thumbnail that looks professional has had its text composited
afterwards. Framecast already burns captions in with ffmpeg and already
enforces that the caption font exists in the worker image — the same mechanism,
the same failure mode, already solved.

### Versions, not overwrites

`ThumbnailVersion` exists and is unused. Each generation appends a version and
moves `Thumbnail.activeVersionId`; nothing is overwritten. Regeneration is the
expected workflow — the first image is often wrong — and comparing attempts is
the point of the model that is already there.

## 4. Logo

`logo.service.ts` generates several square logo options for a channel from its
name, tone and niche. The operator picks one; it is stored and written to
`ChannelBrand.logoPath`. This runs once per channel, not per video.

**The channel avatar cannot be set from here.** The YouTube Data API has no
endpoint for it — `channelBanners.insert` exists for the banner, but the profile
picture is changed by hand in YouTube Studio. The logo is downloadable so the
operator can do that once. Anything else would be promising something the API
cannot do.

## 5. Publish controls

`publish()` changes in four ways:

- **Visibility becomes a parameter**, defaulting to `PRIVATE`. The `UNLISTED`
  hard-code and its expired justification go. `PUBLIC` is now reachable.
- **Tags and playlist** are read from the video and sent in the upload.
- **The thumbnail is uploaded** after the video insert, via YouTube's separate
  `thumbnails.set` endpoint — it cannot ride along with `videos.insert`.
- **`scheduledFor`** sets `status.publishAt` with `privacyStatus: "private"`,
  which is how YouTube schedules.

### Custom thumbnails need a verified channel

`thumbnails.set` returns 403 for an unverified channel. That is a property of
the operator's YouTube account, not something this code can satisfy. A 403 is
therefore **not** a publish failure: the video stays published, the thumbnail is
recorded as not applied, and the operator is told why and what to do. Failing an
otherwise-successful upload over a thumbnail would be the wrong trade.

### Quota

`thumbnails.set` costs 50 units against the same daily allowance as the 1,600
for `videos.insert`. Immaterial at one video a day; recorded because the upload
ceiling is already the platform's tightest external limit.

## Failure handling

Every generated artefact is an enhancement to a video that already renders. The
rule that governs all of them: nothing in this spec may turn a renderable video
into a failed one, and nothing may fail a successful upload after the fact.

| Failure | Behaviour |
|---|---|
| Metadata generation fails | `generatedTitle` stays null, so publish falls back to the operator's own title and today's description; empty tags; `READY` as before |
| Metadata exceeds a YouTube limit | One retry with limits restated, then truncate on a word boundary |
| Image generation fails | No thumbnail; video is publishable and YouTube picks a frame |
| Compositing fails | The generated image is used unmodified rather than none at all |
| Logo missing | Thumbnail composites without a watermark |
| `thumbnails.set` returns 403 (unverified) | Publish succeeds; thumbnail recorded as not applied, with the reason |
| `thumbnails.set` fails otherwise | Same — the upload already succeeded and is not rolled back |
| Brand row missing | Every field falls back to its default; `videoStyle` merges to `DEFAULT_STYLE` |

## Testing

- **Brand:** a null `videoStyle` merges to `DEFAULT_STYLE` exactly; a partial one
  overrides only what it names.
- **Metadata:** limits enforced before upload; an over-long title truncates on a
  word boundary; the operator's original title is preserved; a generation
  failure leaves the video publishable.
- **Thumbnail:** the composite is 1280×720 and under 2 MB; a failed generation
  yields no thumbnail rather than a broken one; a failed composite falls back to
  the raw image; each generation appends a version and moves the active pointer.
- **Publish:** tags and playlist reach the request; visibility is what was asked
  for, not a constant; a 403 from `thumbnails.set` leaves the video published;
  `scheduledFor` sends `publishAt` with `privacyStatus: private`.
- **Quota:** the thumbnail upload is not attempted when no thumbnail exists.

Image generation and YouTube are never called from a test — both are injected,
the same shape `SpeechProvider`, `StockFootageProvider` and `FetchLike` already
use.

## Out of scope

The channel avatar, for the API reason above. Channel banners — `channelBanners.insert`
exists and is automatable, but it is a separate one-off asset with its own
dimensions and belongs with a broader channel-management feature. A/B testing
thumbnails, which needs the YouTube Analytics API and a decision rule, and is
worth building only once there is traffic to test against. Fully automatic
publishing: the operator's click stays, deliberately.
