# Script-matched footage — design

**Goal:** Make the picture show what the narrator is talking about, changing
when the topic changes rather than on a twelve-second timer.

**Status:** Approved by the operator. Ready for an implementation plan.

## Why

A Framecast video today is assembled like this:

- **Footage** comes from a single search using the video's topic as one query
  (`footage.service.ts`, `collect`). Twelve clips are downloaded, played in
  `createdAt` order, and then the whole sequence is repeated until it covers
  the narration (`render.service.ts`, `ensureCoverage`).
- For a seven-minute video that means **the viewer sees the same twelve clips
  three times**, and no clip has any relationship to the sentence being spoken
  over it.
- **Sound** is narration only. There is no music.
- **Captions** are plain SRT rendered by libass in default Arial.

This spec addresses only the footage problem. Music, caption styling and video
structure (hook, chapters, outro) are separate pieces of work, deliberately not
folded in here.

The looping is also what produced the render that kept being OOM-killed: 38
clip inputs opened at once on a 1GB worker. Removing `ensureCoverage` deletes
that failure mode at its source rather than defending against it.

## Decisions taken

| Question | Decision |
|---|---|
| Budget for tooling | A small monthly budget is acceptable |
| What to fix first | Footage matching the script |
| Where cues come from | The script model emits them |
| Where cues are stored | A field separate from the narration text |
| Pacing | Picture changes roughly every 8 seconds |
| Timing model | Cues follow the speech, not a fixed slot |
| Clip retention | Delete a video's clips once it is PUBLISHED |

## Architecture

Three units, each independently testable:

1. **Script generation and cue anchoring** — produces narration plus an ordered
   cue list, and keeps that list attached to the narration across edits.
2. **Footage collection** — turns each cue into one stored clip.
3. **Render timing** — turns each cue into a time range and a segment.

They communicate through stored state (`ScriptVersion.cues`, `Asset`
storage paths, the narration alignment), not through direct calls, so each can
be changed without touching the others.

## 1. Script generation and cue anchoring

### Generation

The script model returns an ordered list of sections, each with narration text
and a b-roll cue. Two things are then stored:

- `ScriptVersion.content` — the sections joined into plain narration. **Byte for
  byte the same shape as today.** Narration, captions and word count are
  untouched.
- `ScriptVersion.cues` — a new JSON column holding an ordered array of
  `{ anchor, cue }`.

`anchor` is the **first eight words of that section, verbatim**.

`cues` is the only schema change in this spec and needs a migration. It is
nullable: every existing ScriptVersion has no cues, and a video whose script
predates this change renders exactly as it does today, drawing entirely from
the fallback pool. No backfill.

The prompt asks for sections of roughly 20–25 words, which is about eight
seconds of speech at narration pace. Section length is guidance to the model,
not a constraint the pipeline enforces — a 30-word section simply holds its
clip a little longer.

### Why anchors, not offsets

Character offsets are exact and die the moment the operator edits the script at
Gate 1. An anchor can be searched for again.

### Why eight words, not the whole section

Anchoring on a section's full text means any edit inside it orphans its cue.
Anchoring on the opening means edits *within* a section keep their cue; only
rewriting a section's first words orphans it.

### Re-anchoring after an edit

`saveEdit` re-anchors before storing. Each cue's anchor is searched for in the
new content **in order**, each search beginning where the previous anchor
ended.

The ordered search is load-bearing: a phrase repeated later in the script must
not capture an earlier cue.

Three outcomes, all explicit:

- Every anchor found → cues intact.
- Some anchors not found → those cues are marked **orphaned**. Their stretches
  fall back to a topic-level clip, which is exactly today's behaviour for that
  stretch.
- Nothing is silently reordered, re-matched fuzzily, or guessed.

The script panel shows which cues no longer match after an edit, so a rewrite
cannot quietly degrade the video without the operator seeing it.

### Why a separate column rather than markers in the script

`voiceover.service.ts:134` sends `content.trim()` to ElevenLabs verbatim.
Anything left in that string is read aloud. A cue marker that failed to strip
would be spoken, burn free-tier quota, and produce a broken video. A separate
column makes that class of failure impossible rather than unlikely.

## 2. Footage collection

### One clip per section

Each cue gets its own search and its own clip, stored at:

```
videos/{videoId}/clips/section-007.mp4
```

Zero-padded, so play order is explicit in the path. Render currently depends on
`createdAt` ordering, which is an accident rather than a guarantee. No schema
change — this follows the existing storage-path convention.

### Provider strategy

Today both providers are searched once per video. Fifty-three cues against both
would be 106 calls per video, and **Pexels allows 200 an hour** — two videos
would exhaust it.

So: **Pexels per cue; Pixabay only when Pexels returns nothing usable.** About
53 calls per video, roughly three videos an hour before the limit binds.

This is a known ceiling, not an oversight. If throughput needs to rise, the
options are caching searches across videos or adding a third source; both are
out of scope here.

### No repeated footage

Different cues frequently return the same popular clip. Collection tracks used
`externalId`s within a video and takes a cue's next-best result when its first
is already taken. Showing the same clip twice is the problem being fixed.

### Every section gets a picture

The existing topic-level search still runs once, now as a **fallback pool**. A
section draws from it when its cue found nothing, failed transiently, or was
orphaned by an edit.

A weak match is worse than a good one. A black screen is worse than both.

### Retention

A video's clips are deleted once it reaches PUBLISHED. They are kept through
READY and FAILED so retries and re-renders work without re-fetching.

At roughly 400MB of footage per video, keeping everything would make storage
the binding constraint at around 200 videos.

## 3. Render timing

### Cue to time range

Once narration exists, each cue's anchor is located in `content`; its section
runs from that anchor to the start of the next cue's anchor, or to the end for
the last one. That character range becomes a time range directly from the
narration alignment — the same per-character data captions already use.

No new source of truth and no second alignment call. This works because
`content.trim()` is what was synthesised, so alignment indices and content
indices are the same indices.

### Variable-length segments

Pass one encodes each section's clip to exactly that section's speaking
duration: short clips loop to fill it (`-stream_loop -1` with an input-level
`-t`, as now), long ones are trimmed.

### Deletions

`ensureCoverage` and `CLIP_SECONDS` are removed. Coverage stops being something
approximated by repeating clips until the narration is covered — the sections
*are* the narration, so they cover it exactly by construction.

The two-pass render (`buildSegmentArgs` / `buildAssembleArgs`) is unchanged.
`planRender` still dedupes by path; with one clip per section there is simply
nothing to dedupe.

### Cost

Fifty-three segment encodes instead of twelve, run one at a time so memory
stays flat. Expect roughly **8–12 minutes per render** on a 1GB/2vCPU Railway
worker, against about two minutes on the operator's Mac.

That is the price of the chosen cutting rhythm. Moving to 12-second pacing
halves it and changes nothing else in this design.

## Failure handling

| Situation | Behaviour |
|---|---|
| Cue search returns nothing | Fall back to the topic-level pool |
| Cue search fails transiently | Fall back to the topic-level pool |
| Cue orphaned by a script edit | Fall back to the topic-level pool; shown in the script panel |
| Fallback pool is also empty | Render fails with the existing "stock footage must be collected" conflict |
| Cue count and section count disagree | Render fails loudly |

The last row is deliberate. That mismatch can only come from a bug, and a video
whose picture silently drifts out of sync with its narration is worse than one
that refuses to render.

## Testing

- **Anchoring:** anchors found in order; an edited section orphaning only its
  own cue; a phrase repeated later not capturing an earlier cue.
- **Timing:** cue ranges against a known alignment, including the final section
  running to the end.
- **Collection:** dedup across cues; fallback on empty results; fallback on a
  provider error; Pixabay used only after Pexels finds nothing.
- **End to end:** a video with some orphaned cues still renders, with those
  sections drawing from the fallback pool.
- **Retention:** clips deleted at PUBLISHED, retained at READY and FAILED.

Tests use throwaway users via `src/test/fixtures.ts`, never
`prisma.user.findFirstOrThrow`.

## Out of scope

Background music, caption styling, and video structure (hook, chapters,
outro). Each is its own spec. Music is the natural next one: it is the other
half of "sound and structure", and it does not interact with anything here.
