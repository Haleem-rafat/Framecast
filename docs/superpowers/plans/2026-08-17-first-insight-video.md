# Rendering the first single-insight video

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One real forty-to-fifty-second vertical video in the new format, rendered end to end, watched, and judged.

**Spec:** `docs/superpowers/specs/2026-08-17-knowsense-format-design.md`

---

## Read this first: none of it is wired in

Phases 1–3 built parts. **Not one of them runs during a render today.** Generating a video right now would produce an ordinary Framecast video and touch none of the new code.

| Built | Consumed by |
|---|---|
| `insight-script.ts` (the gate) | nothing |
| `kinetic-captions.ts` (ASS) | nothing — `render.service.ts:503` still calls `buildSrt` |
| `Scene.beat` / `Scene.emphasis` | nothing, **and see the correction below** |
| Per-boundary transitions | nothing — no caller passes an array |
| `Inter Black` in the worker image | nothing, **and the image has not been rebuilt since** |

So "test the new style" is not a generate-and-look task. It is the wiring, then the generate.

## A correction I owe on Phase 3

I added `beat` and `emphasis` to the `Scene` model. **`Scene` is dead.** Nothing in `src/services` reads or writes `prisma.scene`; the only hits are the word "scene" in comments and prompt strings.

The live per-shot record is **`ScriptVersion.cues`** — a `Json?` column holding `ScriptCue[]`, where a cue is `{ anchor, cue }`: eight words that locate the section in the narration, and what to show during it. `anchorCues` maps those onto character offsets, `cueWindows` turns offsets into time windows using the ElevenLabs alignment, and `footage.service` collects one clip per cue.

That is the seam the format's scenes map onto, one scene to one cue. So `beat` and `emphasis` belong on `ScriptCue`, not on a table nobody queries.

The migration already ran on test and staging. It is additive and harmless, so the fix is to **stop using those columns rather than to revert them** — but Task 1 below moves the fields to where they are actually read, and the dead columns get dropped in a later tidy rather than being left as a trap that looks live.

---

## What one test video costs

| Stage | Calls | Cost |
|---|---|---|
| Script | 1 Claude call, ~1.5k tokens out | ~$0.01 |
| Narration | ~130 words ≈ 800 characters | ~$0.02 |
| Stills | 12 scenes × `gpt-image` | **~$0.60** |
| Render | worker CPU on the VPS | £0 |
| **Total** | | **~$0.65** |

The stills dominate. A dry run that stops before footage costs about three cents, which is why Task 6 does exactly that before Task 7 spends anything.

---

### Task 1: Put beat and emphasis where they are read

**Files:** `src/lib/script-cues.ts`, `src/services/script.service.ts`

- [x] Add to `ScriptCue`: `beat?: string`, `emphasis?: string[]`. Both optional — every cue written before today has neither, and `cues` is a `Json?` column with no schema migration involved.
- [x] Carry them through `anchorCues` into `AnchoredCue`, and through `cueWindows` into `CueWindow`. Today those two drop everything except `cue`; the render needs `beat` to know which join dips and `emphasis` to colour the caption.
- [x] Tests: a cue with a beat survives anchoring and windowing; a cue without one still produces exactly what it does today.

### Task 2: Teach the generator to emit the format

**Files:** `src/services/script.service.ts`, a new prompt template

- [x] Seed a SCRIPT-category `PromptTemplate` holding the pack's Stage 1 system prompt, with `claude-sonnet-5` — **not** the `claude-sonnet-4-6` the pack names, which does not exist.
- [x] Parse the returned JSON into `{ content, cues }`: `content` is the narrations joined with a space; each cue is `{ anchor: first 8 words of that scene's narration, cue: visual_brief, beat, emphasis }`.
- [x] Run `validateInsightScript` before persisting. On failure, retry once with the errors appended — the messages were written to be pasted in verbatim. Two failures, give up and report; do not silently keep a bad script.
- [x] Test the parse against the worked example in the spec.

### Task 3: Switch the caption format on for this style

**Files:** `src/services/render.service.ts`, `src/lib/video-style.ts`

- [x] Add `captionMode: "srt" | "kinetic"` to `VideoStyle`, defaulting to `"srt"`. Every existing render keeps calling `buildSrt` and its argv is unchanged.
- [x] When kinetic, write `.ass` from `buildAss` instead, with the emphasis words for each cue's window, and hand that path to `buildSubtitleFilter` — which already accepts ASS, since libass reads it natively.
- [x] Use `KINETIC_CAPTION_FONT` (`Inter Black`).
- [x] Test: a kinetic render writes a `.ass` and an ordinary one still writes a `.srt`.

### Task 4: Dip through black before the payoff

**Files:** `src/services/render.service.ts`

- [x] Build the transitions array from the cue beats: hard cut everywhere, `{ enabled: true, durationSeconds: 0.2, kind: "fadeblack" }` at the single boundary whose *next* cue is the first `NAME_IT`.
- [x] Guard the case the format can produce and `planRender` refuses: a scene shorter than the dip. The spec's floor is 2.5s and the dip is 0.2s, so this should never fire — but a model that emits a 0.15s scene must fail loudly here, not produce an inverted concat entry.
- [x] Test: beats in, array out, dip in exactly one place.

### Task 5: The cinematic footage style

**Files:** `prisma/schema.prisma` (+ migration), `src/lib/footage-styles.ts`, `src/lib/art-styles.ts`, `src/services/footage.service.ts`

- [x] Add `FootageStyle.CINEMATIC`. Classify it in `isGeneratedFootage` — it generates, so the enum forces the decision at compile time.
- [x] Unlike `ILLUSTRATED`, it needs **no character sheet**: the format explicitly wants a different person per shot, with only the grade and lens held constant. That is the one real code difference.
- [x] Add the pack's style bible as the prompt fragment, and its Stage 2 formula as the expander.

### Task 6: Dry run — spend three cents, not sixty

**Read this before running it.** Tasks 2-5 are wired and committed. One thing
they did not resolve, found while wiring Task 5 and deliberately not fixed
without the owner present:

**A cinematic video gets two pictures, not twelve.** `CINEMATIC` reuses the
illustrated collection path, and that path draws one picture per *story beat*
— `planStoryBeats` at `BEAT_TARGET_SECONDS = 20`, a number measured on
four-minute children's stories. A 45-second narration with twelve cues
therefore comes out as **two** beats of ~22s each, not twelve shots of ~3.5s.
The cost table above (12 stills, ~$0.60) assumes the second. So does the
format: "shot changes every 3-5s" is most of what separates it from a
slideshow.

Fixing it is not a one-line change, which is why it was left. The picture count
has to be agreed by `footage.service.ts` *and* `render.service.ts` without a
stored plan — that is what `planStoryBeats` is for — and `render.service.ts`
deliberately reads what is on disk rather than the channel's `footageStyle`, so
it cannot simply be told which target to use. The options are a beat plan keyed
on the style (which means the renderer has to learn the style, and the reason it
does not know it today is a real one) or a plan derived from what collection
actually produced. Both are design decisions with the owner's video on the line.

Everything else below is unaffected: the script, the gate, the beats, the
transitions array and the `.ass` captions do not go through `planStoryBeats` at
all.

- [ ] Rebuild the worker image so it actually contains `Inter Black`. **The current image predates the Dockerfile change**, so a render today falls back to DejaVu silently.
- [ ] Generate a script only, against staging. Confirm: valid JSON, passes the gate, six beats present, 95–150 words, cues anchored.
- [ ] Confirm the plan before footage: 8–14 cues, one `fadeblack` boundary, captions resolving to `.ass`.
- [ ] Stop here if anything is wrong. Nothing above this line has generated a picture.

### Task 7: The real render

- [ ] Generate one video on **staging**, vertical, cinematic footage, kinetic captions.
- [ ] Watch it. The judgement is not "did it render" — it is: does the first three seconds hold, do the captions land on the spoken word, does the dip read as a beat, and does it look like one film or twelve.
- [ ] Do **not** publish it. Auto-publish stays off; this is a look, not a release.

---

## What will most likely go wrong

**The font falls back silently.** libass resolves by name and says nothing when it misses. If the captions come out looking un-styled, the image is stale — Task 6 rebuilds it first for exactly this reason, and the Dockerfile assertion now fails the build rather than the render.

**The stills look like twelve different films.** The spec's own warning. The fix is that the style bible lives in the system prompt only, never diluted into the per-scene message.

**The model emits scene durations the render ignores.** Expected and correct — `planRender` derives length from where narration actually falls. The declared numbers are a validation signal, not a timing instruction.

**Word timings drift from the captions.** `buildAss` reads the same `Alignment` as `buildSrt`, so if this is wrong it was wrong already — but a word-level caption makes a drift visible that a six-word cue hid.
