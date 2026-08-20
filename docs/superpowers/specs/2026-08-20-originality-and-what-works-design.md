# Originality, and learning what works

*2026-08-20*

## What this is

The operator asked for two things in one sentence: make sure a video is not
duplicated content, and have the AI analyse videos so that when one reaches
people, the pattern behind it is saved and applied to every video after it.

They are two features, not one, and they fail for different reasons. The first
is straightforward and cheap and should be built now. The second is blocked on
a metric YouTube will not give this app, and is worthless for months after it
ships even if it is built perfectly — for reasons of arithmetic, not code.

Everything below stated as a fact about the current codebase was read out of it
and is cited. Everything unverified is named as unverified.

---

## The short version

| | |
|---|---|
| **Duplicate detection today** | A 120-second double-submit guard. Nothing else. |
| **What is actually missing** | Same-channel repetition at topic level and at script level |
| **Recommended** | Two layers: normalised-topic match (refuses), script embedding similarity (warns) |
| **Cost of that** | One embedding call per approved script. No new service, no extension. |
| **"Learn what works" blocker** | `impressions` and `clickThroughRate` are permanently `0` — see Part 3 |
| **Consequence** | The loop can learn about **scripts and topics**. It cannot learn about thumbnails or titles. |
| **Second blocker** | Sample size. Three videos a week per channel is months before a "pattern" is not noise. |
| **Recommended shape** | Ship originality alone. Then a read-only "what worked" panel. Automate nothing until the panel has been right for a quarter. |

---

## Part 1 — What already exists

### The duplicate guard is a double-click guard

`automation.service.ts:568` — `guardDuplicateSubmission` looks for another
video with **the same `userId`, the same `projectId`, the byte-identical
`topic` string**, created within `DUPLICATE_WINDOW_SECONDS` (`= 120`,
line 104) of the row just written.

That is a good guard and it is not the thing being asked for. It exists so a
double-tapped button does not bill two scripts. Two minutes later, or with one
character different, or in another project on the same channel, it lets
everything through — as it should, because it was never a content check.

### Easy mode already tells the model what has been covered

`easy-mode.service.ts:788` — `listCoveredTopics` reads the last
`RECENT_VIDEO_LIMIT` (`= 40`) topics for the channel, **including soft-deleted
ones** ("a subject the operator made and then binned is one they have already
judged"), and passes them to the model that suggests subjects.

This is a *hint*, not a check. The model is asked not to repeat; nothing
verifies that it did not, and nothing at all constrains the manual path or a
schedule's `ScheduleTopic` queue.

### The analytics that exist

`VideoAnalytic`, one row per publication per day: `views`, `likes`, `comments`,
`impressions`, `clickThroughRate`, `averageViewSeconds`, `watchTimeMinutes`,
`subscribersGained`, `estimatedRevenue`. Collected by
`channel-analytics.service.ts` on the worker's slow tick.

### The only places a "pattern" could be fed back into

This matters more than it sounds, and it is the constraint that decides what
Part 4 can even propose. Generation reads exactly these inputs:

- `PromptTemplate` + its `PromptVariable` values
- the script style (`lib/script-styles.ts`) and target length
- `Channel.footageStyle`, `Video.format`
- the topic string itself

Anything a "learned pattern" cannot be expressed as changes nothing.

---

## Part 2 — "Duplicate" is three different things

| | What it is | Status |
|---|---|---|
| 1 | The same submission twice | **Solved** — `guardDuplicateSubmission` |
| 2 | A topic this channel has already published | Hinted at in easy mode, unenforced everywhere |
| 3 | A different topic that produces the same video | **Nothing** |

(3) is the one that damages a channel. Two videos called "Why the Romans built
straight roads" and "The engineering behind Roman roads" are different strings,
pass every check in the codebase today, and are the same video.

### The recommended shape: two layers, at two different moments

**Layer 1 — normalised topic, before any spend.**

Lowercase, strip punctuation and stop words, sort the remaining tokens, compare
against every non-deleted `Video.topic` and `generatedTitle` on the same
channel. Exact match on the normalised form, plus a trigram similarity above a
threshold, is a **refusal** — a `ConflictError` naming the existing video, in
`AutomationService.start` beside the existing guard, before
`scriptService.generate` is reached and therefore before a single billed call.

Deliberately dumb and deliberately deterministic: it costs one indexed query,
it can be unit-tested without a model, and it catches the overwhelmingly common
real case, which is the operator or a schedule proposing something they already
made.

**Layer 2 — script similarity, after generation and before approval.**

Embed the approved script's hook and beat sentences once, store the vector, and
compare a new script against the stored vectors for that channel. Above a
threshold, the video detail page says *which* earlier video this resembles and
requires an explicit "generate anyway" — a **warning with an override**, never a
silent refusal.

Why a warning and not a refusal: a channel with a niche legitimately returns to
subjects, a sequel is not a duplicate, and this layer is the one making a
judgement call rather than reading a string. A refusal here would eventually
block work the operator meant to do, and the operator is the only party who can
tell the two apart.

### Why no pgvector, and no new extension

A channel has tens to low hundreds of videos. Loading N vectors and computing
cosine similarity in Node is microseconds of work on a set that size. `pgvector`
would mean an extension the VPS's `postgres:17-alpine` image does not carry, a
migration that fails on a box where it is missing, and an index that earns
nothing below roughly six figures of rows.

Store the vector as a `Float[]` column and compute in the service. Revisit only
if a channel passes a few thousand videos, which at three a week is not this
decade.

---

## Part 3 — The half of this that is blocked, and why

### `impressions` and `clickThroughRate` are always zero

`lib/youtube-analytics.ts:71` states it outright:

> The Analytics API never reports impressions or CTR for a channel query.

and exports `impressionsKnown = false`. `channel-analytics.service.ts:896`
leaves both columns at their defaults on every write. The columns exist; the
numbers do not arrive.

This is not a bug to fix — it is what the API returns for the authorisation this
app holds — and it removes the single most useful signal for the thing the
operator most likely means by "good for views". **Thumbnail and title
performance cannot be measured here.** Any feature claiming to learn what makes
a thumbnail work would be learning from `0`.

### What can be measured

`views`, `watchTimeMinutes`, `averageViewSeconds` (a real retention proxy),
`subscribersGained`, `likes`, `comments`. That is enough to rank videos and to
say something honest about *scripts*: which style, which length, which subject
shape held people.

### The arithmetic problem nobody can code around

Three channels, three long videos a week. To compare two script styles with any
confidence you need both to have run enough times for the difference between
them to exceed the week-to-week noise of a small channel — and small-channel
view counts are dominated by whether a video happened to be shown at all.

A "pattern" declared from four videos is a coin flip with a dashboard around it.
That is the failure mode to design against: the feature will *look* like it is
working long before it is telling the truth.

---

## Part 4 — What a pattern can honestly be

Given Part 1's list of feedable inputs and Part 3's list of trustworthy metrics,
a pattern is a tuple:

```
(script style, target length, footage style, topic shape) → score
```

where `score` is a normalised blend of retention (`averageViewSeconds` over
video duration) and reach (`views` relative to the channel's own median for the
period), measured at a **fixed age** — 14 or 28 days after publication, never
"now", or every comparison silently favours whichever video has been up longest.

Feeding it back, in increasing order of how much damage it can do:

1. **Rank easy-mode suggestions.** The subject picker already receives covered
   topics; it can receive the winning tuple too. Costs nothing, changes one
   list's order, and is trivially reversible.
2. **Default a new series or schedule** to the winning tuple, shown as
   "your best-performing shape" with the numbers behind it, and editable.
3. **Nothing else.** In particular, not an instruction to the writing model to
   "write like the successful ones". That is the version that feels intelligent,
   cannot be measured, and quietly makes every video a copy of one outlier.

---

## Part 5 — Schema

Two additions, both small:

```prisma
model VideoFingerprint {
  id              String   @id @default(uuid()) @db.Uuid
  videoId         String   @unique @db.Uuid
  topicNormalised String                       // layer 1
  scriptEmbedding Float[]                      // layer 2, empty until a script is approved
  embeddingModel  String                       // so a model change is detectable rather than silent
  createdAt       DateTime @default(now())
}
```

and a rollup — or no rollup at all in phase 1, computed on read from
`VideoAnalytic`, which is small enough to aggregate live and avoids a second
source of truth for a number nobody is acting on yet.

`embeddingModel` is not optional: vectors from two different models are not
comparable, and without the column a model upgrade turns every stored vector
into silent noise that still returns plausible-looking numbers.

> **Migration naming.** Folder timestamps in `prisma/migrations/` run ahead of
> the calendar (the newest is `20260903090000`). Name a new migration after the
> newest existing folder, not after today's date, or it sorts into the middle of
> history and never runs on a deployed database.

---

## Part 6 — The staging plan

**Phase 1 — Originality.** Both layers, the schema above, the refusal in
`AutomationService.start`, the warning on the video detail page. Independently
useful, testable without a single analytics row, and the half the operator can
feel immediately.

**Phase 2 — A read-only "what worked" panel.** The scoring in Part 4, rendered
on /analytics, ranking published videos at a fixed age with the tuple beside
each. Nothing is automated. The point of this phase is to find out whether the
scores say anything true before anything acts on them.

**Phase 3 — Feedback, if and only if phase 2 earned it.** Suggestion ranking
first; series defaults second. Gate the phase on a real question: after a
quarter of data, does the panel's top tuple actually beat the channel median?
If it does not, the loop does not ship and phase 2 keeps standing on its own.

---

## Open questions for the operator

1. **Refuse or warn on layer 1?** The recommendation is refuse, on the grounds
   that an exact repeat is never intended. Warning instead is defensible.
2. **How far back does "already covered" reach?** Easy mode uses 40 videos. A
   channel republishing a subject after two years is not duplicating it.
3. **Is "good for views" reach or retention?** They diverge, and Part 4's score
   blends them. Which one is the channel actually being run for?
