# Framecast — First Video (Walking Skeleton)

**Date:** 2026-08-09
**Status:** Approved for planning
**Scope:** The thinnest complete path from an approved script to a video published on YouTube.

---

## 1. Goal

Turn an approved script into an MP4 on the operator's channel. Deliberately crude in every
stage except correctness.

This exists to **prove the chain before polishing any link in it**. The render is the
largest unknown in the whole product — FFmpeg assembly, audio/video sync, caption timing,
file sizes, upload quotas — and none of it is proven. Building good raw materials first
would mean discovering the consumer's problems weeks later, when changing course is
expensive.

**Done when:** the operator watches a video on their own channel that Framecast produced
from a topic, and can say what specifically about it is bad. That list is the backlog for
sub-project 2.

### Explicitly not in scope

- Matching clips to what the narration is saying — clips run on a timer
- Thumbnails, Shorts extraction, scheduling
- A render worker or job queue — see §3
- Public publishing — see §7

---

## 2. Prerequisites, all verified

| Dependency | State |
|---|---|
| Claude via AI Gateway | ✅ live, $0.001104 measured |
| ElevenLabs | ✅ key in the credential vault, **free tier, 10,000 chars/month** |
| Pexels | ✅ verified — 8,000 results for a finance query, 4K MP4 |
| Pixabay | ✅ verified — 500 hits, 3840×2160 |
| FFmpeg 8.0.1 | ✅ local, with `libx264`, `aac`, `subtitles` |
| YouTube channel | ✅ connected, upload + analytics scopes granted |
| Supabase Storage | ⚠️ bucket must be created — first task |

---

## 3. Architecture — the render runs on the operator's Mac

Vercel functions cap at 300s and FFmpeg encoding of an 8-minute video exceeds that. The
final design puts the renderer on a separate always-on worker.

**This skeleton does not build that worker.** The render is a local CLI command:

```
pnpm render <videoId>
```

It reads the video and its script from the database, calls ElevenLabs, downloads clips,
runs FFmpeg, uploads the result, and writes progress back to `RenderJob` as it goes.

Reasons, in order of weight:

1. **It removes the largest source of unknowns from the critical path.** A worker adds a
   host, a deployment, a queue, and a lease protocol — none of which teach us anything
   about whether the video comes out right.
2. FFmpeg is already installed and the operator can watch it run and inspect the output.
3. It costs nothing.

The worker becomes an extraction *after* the pipeline is known to work, and it will be a
better worker for being written against a known-good implementation. The service layer is
written so that lift is mechanical: **every stage is a service method taking a `videoId`,
with no dependency on where the process runs.**

---

## 4. The five stages

### 4.1 Narration → `VoiceOver`

`POST /v1/text-to-speech/{voiceId}/with-timestamps` returns base64 audio **and**
character-level alignment in one call. Timing therefore comes free with the audio, with
no second service and no drift.

Store the MP3 in Supabase Storage; record `provider`, `voiceId`, `voiceName`, `audioUrl`
and `durationSeconds` on `VoiceOver`. Keep the raw alignment as an `Asset` — captions are
derived from it in §4.3 and regenerating them must not require re-billing the audio.

**Free-tier ceiling:** 10,000 characters/month, and a full 8-minute script is ~7,000. The
first test consumes most of a month's allowance. The renderer must therefore **refuse to
re-synthesise audio that already exists** unless explicitly forced — an accidental re-run
would exhaust the quota.

### 4.2 Footage → `Asset`

Search Pexels and Pixabay for video clips using keywords derived from the video's topic.
Take `ceil(durationSeconds / 12) + 2` clips, alternating sources so a single provider's
stock look does not dominate.

**Both clips must be downloaded to our own storage.** Pixabay's terms forbid permanent
hotlinking, and a CDN URL that expires mid-render would fail unpredictably.

Pixabay's terms also require attribution wherever results are shown. The publish step must
put a credit line in the video description.

### 4.3 Captions → SRT

Group the character alignment into caption lines of roughly 5–7 words, breaking on
sentence punctuation where possible. Write SRT and store it as an `Asset` of kind
`SUBTITLE`.

Captions are the largest retention lever on faceless content and most viewers start muted,
so this is not optional even in a skeleton.

### 4.4 Render → MP4

FFmpeg, one pass:

1. Scale and centre-crop every clip to 1920×1080, trimmed to 12s
2. Concatenate, looping the sequence if the clips are shorter than the narration
3. Replace all clip audio with the narration track
4. Burn in the SRT with the `subtitles` filter
5. Encode `libx264` + `aac`, cut to exactly the narration's duration

`RenderJob` carries `status`, `progress`, `attempts` and `outputUrl`; `RenderLog` takes
FFmpeg's stderr so a failure is diagnosable after the fact rather than only while watching.

### 4.5 Upload → `Publication`

YouTube Data API `videos.insert`, resumable. Title and description from the video record,
plus the sources section from the script and the Pixabay attribution.

**`privacyStatus: "unlisted"`.** See §7.

Uploading costs 1,600 quota units of a 10,000/day allowance — about six uploads a day,
far beyond this skeleton's needs.

---

## 5. Data model

No schema changes. Every table already exists: `VoiceOver`, `Asset`, `RenderJob`,
`RenderLog`, `Publication`, `VideoStatusEvent`.

The status flow uses the existing enum, unchanged:

```
QUEUED → GENERATING (narration, footage, captions)
       → RENDERING  (FFmpeg)
       → READY      ← 👤 GATE 2: the operator watches it
       → PUBLISHED
```

Gate 2 is enforced the same way Gate 1 is: a single atomic conditional update guarded on
the current status, with the transition appended to `VideoStatusEvent`. Gate 1's first
implementation had a check-then-act race that let two approvals both succeed; do not
reintroduce that shape here.

---

## 6. Cost per video

| Stage | Cost |
|---|---|
| Script | ~$0.03 |
| Narration | free tier now; ~$0.30–1.00 on a paid plan |
| Footage | free |
| Render | free (local) |
| Upload | free |

The economics from the main design hold: **narration is 70–90% of marginal cost.**

---

## 7. Unlisted, not public — deliberate

Free-tier ElevenLabs audio carries **no commercial rights**. Publishing it publicly on a
channel intended for monetization is a licensing violation, and YouTube's policy on
automated content makes an early misstep expensive to undo.

The renderer sets `unlisted` and does not accept a `public` option. Publishing publicly is
a decision for after the operator has (a) upgraded ElevenLabs and (b) watched a rendered
video they are willing to put their channel's name on.

---

## 8. Error handling

Each stage is independently resumable. A failed render must not re-bill narration — that
is the whole reason the audio and alignment are persisted rather than held in memory.

`Video.status` moves to `FAILED` with `failureReason`, and re-running resumes from the
last completed stage. Provider failures wrap in `ProviderError` with `retryable` set from
the status code, matching the existing convention.

---

## 9. Testing

Provider calls are injected, as with `ScriptService`, so tests never hit the network or
spend quota.

| Layer | Tested |
|---|---|
| Caption builder | alignment → SRT: line grouping, timing, escaping |
| Footage selection | clip count for a given duration, source alternation, dedup |
| FFmpeg command builder | the argument list, as a pure function — no invocation |
| Stage resumption | a failed render does not re-synthesise existing audio |
| Gate 2 | concurrent approvals produce exactly one transition and one event |

Service tests use their own throwaway `User`. Borrowing the operator's account destroyed a
real credential earlier today; that must not recur.

The FFmpeg invocation itself is verified by running it once, by hand, and watching the
output — a test asserting that video encoding "worked" proves very little.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Narration quota exhausted by re-runs | Never re-synthesise existing audio without an explicit force flag |
| Audio and video drift apart | Cut the final render to the narration's exact duration |
| Clips shorter than the narration | Loop the sequence; check total length before encoding |
| Free-tier audio published publicly | `unlisted` hardcoded, no public option |
| Pixabay attribution missed | Credit line added by the publish step, not left to the operator |
| Render takes very long | Progress written to `RenderJob`; encode 1080p, not 4K |

---

## 11. Task decomposition

Seven tasks, each independently testable:

| # | Task |
|---|---|
| 1 | Supabase Storage bucket + upload/download helpers |
| 2 | ElevenLabs narration service with timestamp persistence |
| 3 | Caption builder — alignment to SRT |
| 4 | Footage service — Pexels + Pixabay search, download, store |
| 5 | FFmpeg command builder and local render runner |
| 6 | YouTube upload service + Gate 2 |
| 7 | `pnpm render <videoId>` CLI tying the stages together |

---

## 12. What this deliberately gets wrong

Clips will not match the narration. A section about Blockbuster's bankruptcy may run over
stock footage of a trading floor. **That is the intended outcome of this sub-project**, not
a defect to file.

The purpose is a real artefact to react to. The list of things wrong with it is more
valuable than a longer-planned first attempt, because it will be a list of things that are
actually wrong rather than things predicted to be wrong.
