# Short hooks: fresh openings, a hook card, and alternating endings

Project 1 of the quality/growth update. Scope is English history Shorts on the
Money Mechanics channel, but nothing here is channel-specific.

## Why

A read of all 45 Shorts on the channel on 2026-09-18:

- History stories are the only thing that works (median 936 views, 9 of 17
  past 900). Nothing has passed ~1,300 — the first test pool. The work is
  getting past that wall, not copying what reached it.
- **Every one of the 17 history Shorts opens "Did you know…".** A formula the
  viewer has already learned to ignore, and a repetition signal under YouTube's
  inauthentic-content policy for mass-produced channels.
- The first on-screen text is a caption fragment ("OBSESSION BEYOND", "MING
  COURT") that means nothing with the sound off.
- Endings resolve and stop. Comments run 0–3 per Short.

"Did you know" is not in the code — `vertical-short` already bans it. It comes
from a prompt stored in the production database. So the fix is enforced in
code, independent of how any stored prompt is worded.

## Which scripts are affected

Every script whose target length is **90 seconds or less**, whatever template
or automation produced it. Format (landscape/vertical) is chosen at approval,
after the script exists, so it cannot be the trigger. The target length is
read the way `script.service.ts` already reads it: a `seconds` variable is
seconds; a `duration` variable is minutes. A script with neither is not gated.

Long-form scripts are untouched, byte for byte.

## Part 1 — Opening gate

Two pure checks beside `checkHook` in `src/lib/short-hook.ts`:

1. **Formula openers.** Refuse a first sentence that begins with any of
   `FORMULA_OPENERS`: "did you know", "what if i told you", "have you ever",
   "imagine", "this is the story of", "meet", "ever wonder", "here's why",
   "here is why", "you won't believe", "picture this". Exported, lowercase,
   matched at the start on a word boundary, as `CONTINUATION_OPENERS` is.
2. **Freshness.** `checkOpenerFreshness(hook, recentHooks)` refuses a hook whose
   first three words (lowercased, punctuation stripped) equal the first three
   words of any recent hook. `recentHooks` is the first sentence of the
   channel's last 10 gated scripts (active versions, newest first).

The prompt gains an **opening shapes** block: eight named shapes with one
example each — famous name + twist, extreme number, flat verdict, scene in
motion, contradiction, stakes, the object, the aftermath — and the line "Recent
videos on this channel opened like this: …; open differently." Guidance only;
the gate is the authority.

On failure: retry once with `RETRY_PREFACE` plus the gate's sentences (the
existing gated-format loop, extended to gated prose). Second failure throws
`ValidationError`; the video fails before narration, and a schedule records it
as any other failed run. Both attempts are billed and summed by `billedTotals`.

## Part 2 — Hook card

- `hook_card` is added to both `scriptSchema` and `insightScriptSchema`,
  optional in the schema, **required by the gate** for gated scripts.
- Rules: 2–6 words; no emoji; not equal (normalised) to the first sentence;
  does not start with a formula opener.
- Stored in a new nullable `ScriptVersion.hookCard String?`. Old scripts have
  none and render unchanged.
- Rendered by a pure `hookCardEvents()` beside `kinetic-captions.ts`: one ASS
  style (top-centre, `Alignment 8`, bold, upper-case, large, thick outline) and
  one event from 0.00 to 3.00s with a 300ms fade-out. Appended to the ASS file
  the render already burns. When `captionMode` is `srt`, the card is written
  to its own ASS file and burned in the same pass.
- **Vertical renders only.** A landscape render ignores the column.

## Part 3 — Endings

- `EndingKind` enum `LOOP | DEBATE`, stored in `ScriptVersion.endingKind`
  (nullable).
- `nextEndingKind(previous)` alternates; with no previous gated script on the
  channel, `LOOP`.
- The chosen kind adds one instruction to the system prompt:
  - LOOP — the last line leads back into the first sentence so a replay reads
    as continuous.
  - DEBATE — end on a flat, arguable verdict, stated, never asked.
- The gate refuses an ending that asks for engagement: last sentence contains
  "comment", "let me know", "subscribe", "follow", "like and", or ends in "?".

## Data

One migration adding `ScriptVersion.hookCard String?`,
`ScriptVersion.endingKind EndingKind?` and the enum. Migrations are applied by
hand on the VPS; an unapplied one 500s sign-in.

## Testing

- Unit (pure): formula openers, freshness match, card rules, ending rules,
  `nextEndingKind`, `hookCardEvents` output.
- `script.service` (real Postgres via the tunnel): gated prose rejected once
  then accepted; rejected twice → `ValidationError` with both attempts billed;
  a 5-minute script is never gated and sends the identical request it did
  before; freshness reads only the same channel's scripts.

## Out of scope

Shorts cut from long videos (`shorts.service.ts`) — no card in v1. Arabic.
Image, animation and thumbnail changes (projects 3–5).
