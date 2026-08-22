# A daily cadence across three channels

*2026-08-22*

## What this is

A plan for publishing **one long video and three reels every day on each of
three channels** — Dev Pixel, Money Mechanics and KIDO FUN ZONE — and a study
of which style each channel should use and when each should publish.

The headline finding is that the expensive reading of the request and the cheap
one produce the same output. Three reels a day does not mean three generations
a day: `release.service.ts` exists precisely for this and says so — it is *"a
release queue with a timer on it, spending clips already produced and paid for.
Nothing in it calls a model."* A reel is re-composed from the section clips the
long video already played. So the daily cadence costs **one video per channel
per day**, not four.

## Part 1 — the style study

### What each channel is

| Channel | Niche | Tone | Made for kids | Set up |
| --- | --- | --- | --- | --- |
| Dev Pixel | frontend and backend web development | direct and practical, one engineer talking to another | no | `DOODLE` / `doodle-marker` |
| Money Mechanics | personal finance and small business | clear and grounded, plain numbers and no hype | no | `CINEMATIC`, `insight-short` preset |
| KIDO FUN ZONE | playful stories and small discoveries for young children | warm, playful and encouraging | **yes** | `ILLUSTRATED` / `coloured-pencil`, character sheet generated (Pip, a bear cub) |

### Dev Pixel → `marker-doodle`

**Recommended, and it is the one recommendation backed by the operator's own
behaviour rather than by argument.** Ten doodle shorts were made on this channel
and **nine were published**, by hand, across several hours. No other style in
this app has that hit rate here.

The reason it suits the niche is structural rather than aesthetic. A software
story has no photographable subject: a race condition, a config nobody wrote
down, a test that never ran. `CINEMATIC` would return a stock-looking person at
a laptop for all of them, because that is the only thing a photographic model
can produce for "the migration ran twice". A stick figure can be *doing the
thing* — pointing at a rack, crumpling a receipt, standing between two servers —
because the drawing is free to be diagrammatic.

Its documented weakness ("it cannot carry mood or place — the story has to do
all of it") costs least here, because a developer story is carried by its turn,
not its atmosphere.

### Money Mechanics → `insight-short` for reels, `CINEMATIC` long form

**Also evidence-backed**: the Short the operator held up as the target
(`S62_CLND-g8`) is this style, on this channel.

Finance is the opposite case to Dev Pixel. Its subjects are photographable —
a receipt, a parking ticket, a hand at a ledger, a person reading a bill — and
the genre's credibility comes partly from looking real. `CINEMATIC`'s rule of
holding the grade and the lens while changing the person every shot is exactly
right for second-person money writing.

**But `insight-short` cannot be the long video.** The insight format's validator
pins 10–14 scenes and 95–150 words — forty to fifty-five seconds. A daily long
video needs a long-form script style over the same `CINEMATIC` footage:
`case-study` or `longform-list` are the candidates, and `case-study` fits the
tone ("plain numbers and no hype") better than a countdown does.

So this channel runs **two styles**, which is the one place the preset model
does not currently reach — see the gap in Part 3.

### KIDO FUN ZONE → `ILLUSTRATED` / `coloured-pencil`, unchanged

**Do not change this channel.** Three reasons, and the third is not negotiable:

1. It is already correctly configured, including the expensive part — a
   character brief and a generated character sheet. `collectGenerated` refuses
   an illustrated channel without one, so this is the only channel that is
   ready to run today.
2. `BEAT_TARGET_SECONDS = 20` — the pacing every other format overrides — was
   measured on *exactly this genre*: Koala Moon, Sleeptime Music & Stories,
   Twinkle Tales Time. `story-beats.ts` derives it from a 32-page picture book
   yielding 12–14 spreads. This channel is the one the default was built for.
3. **`madeForKids` is true.** The doodle and insight styles are both wrong here
   and one of them is disqualified: the insight format is second-person writing
   about a psychological effect, which is not children's content. `art-styles.ts`
   also records that `CARTOON` "does not work for children's content and cannot
   be made to".

The cheapest channel to run, too: bedtime pacing at 20s a picture means a
four-minute video is about twelve pictures.

### Summary

| Channel | Long video | Reels | Why |
| --- | --- | --- | --- |
| Dev Pixel | `marker-doodle`, 5 min | cut from it | 9 of 10 published; abstract subjects need drawing |
| Money Mechanics | `CINEMATIC` + `case-study`, ~6 min | cut from it, kinetic captions | photographable subjects; matches the target Short |
| KIDO FUN ZONE | `ILLUSTRATED` / `coloured-pencil`, 4 min | cut from it | already set up, made-for-kids, the pacing default's home genre |

**Three different styles across three channels is the right answer**, and not
only for variety: each is chosen against a property of its subject matter that
the other two do not have.

## Part 2 — when to publish

### What the evidence says

Synthesised from 2026 posting-time studies, which themselves draw on Buffer's
2024 analysis of 1.8 million videos and YouTube's Creator Insider guidance:

- **Tuesday to Thursday, 14:00–18:00** is the strongest general window, with
  Tuesday 11:00–12:00 named as the single best slot by one study.
- Secondary windows: **08:00–10:00**, **12:00–14:00** and **18:00–21:00** on
  weekdays; **09:00–12:00** at weekends.
- The mechanism matters more than the number: the algorithm tests every Short
  on a small audience first and expands only if that batch engages. Publishing
  while the test audience is asleep or at work weakens the first signal, which
  is the one that decides distribution.

Every source also says the same caveat, and it should be honoured rather than
quoted: these are population averages, and a channel's own analytics beat them.
**This app already reads them** — `channel-analytics.service.ts` — so the slots
below are a starting position to be replaced by measurement after two weeks.

### Proposed slots

Three reel slots per channel, spread rather than clustered, chosen against each
audience rather than copied:

| Channel | Slots (local) | `slotMinutes` | Reasoning |
| --- | --- | --- | --- |
| Dev Pixel | 08:30, 12:30, 18:30 | `[510, 750, 1110]` | Developers browse at commute, lunch and after work. The 12:30 slot sits inside the 12:00–14:00 window; 08:30 catches the pre-standup scroll |
| Money Mechanics | 11:30, 15:00, 19:30 | `[690, 900, 1170]` | 15:00 is inside the strongest general window; 19:30 catches evening personal-finance browsing, which is when people actually look at their money |
| KIDO FUN ZONE | 09:00, 15:30, 18:00 | `[540, 930, 1080]` | **Deliberately different.** Children's viewing peaks after school (15:30) and at wind-down (18:00), with a weekend-morning pattern the 09:00 slot serves. The generic 14:00–18:00 advice is derived from adult behaviour |

The long video goes out once a day at **14:00 local** on all three, inside the
strongest measured window and clear of every reel slot so the two never compete
for the same hour.

**Time zone is a real decision, not a default.** `ReleaseCadence.timeZone` and
`Schedule.timeZone` are both IANA zones and both are validated. They should be
set to the *audience's* zone, not the operator's. For English-language channels
whose largest audience is usually US, `America/New_York` is the common answer —
but this is the first thing to check in the channel's own analytics rather than
assume, and it is the single setting with the largest effect on everything in
this table.

## Part 3 — the automation flow

### What already exists

| Need | Mechanism |
| --- | --- |
| Make a video on a timer | `Schedule` + `ScheduleService`, with a `ScheduleRun` audit row per firing |
| Publish it automatically | `Schedule.autoPublish`, or `auto-publish.service.ts` firing on `READY` |
| Cut reels from a long video | `shorts.service.ts` — a model picks the moments, then the worker encodes each one |
| Drip reels at several times a day | `ReleaseCadence.slotMinutes`, whose own comment says "three is the operator's case, not a constraint" |
| Watch it all on one screen | the automation canvas at `/automation` |

Four of the five links are built. The daily cadence is mostly configuration.

### The three gaps

**1. There is no daily schedule.** `ScheduleFrequency` is `WEEKLY | MONTHLY`.
Seven weekly schedules per channel would express it — twenty-one rows across
three channels, each with its own `ScheduleRun` history, all needing to be
paused together when something goes wrong. That is a configuration people get
wrong.

*Proposal:* add `DAILY` to `ScheduleFrequency`. It is the smallest of the three
changes: `dayOfWeek` and `dayOfMonth` are already nullable, `hour`/`minute`/
`timeZone` already carry the time, and the only real work is in whatever
computes `nextRunAt` — one arm that adds a day instead of a week. The enum needs
a migration; nothing else does.

**2. Nothing generates reels when a long video finishes.** The worker encodes
shorts that are already `QUEUED` (`worker/index.ts` claims and calls
`renderShort`), but the step that *creates* those rows — a model reading the
script and picking the moments worth clipping — is operator-triggered. In a
daily flow nobody is there to trigger it.

*Proposal:* extend `auto-publish.service.ts`'s trigger shape rather than
inventing a second one. It already fires on a *state* — a video an automation
created reaches `READY` — which is exactly the moment reels should be selected.
A `Schedule.autoShorts` boolean, defaulting false, keyed on the same state.

The safety property to preserve: `shorts.service.ts` is documented as writing
nothing to `Video`, so a selection that fails leaves the parent `READY` and
publishable. Automatic selection must not change that.

**3. Only one release cadence exists.** Two more rows and their slot arrays,
which is configuration rather than code.

### The flow, end to end

```
06:00  schedule fires (DAILY)      → creates video, generates script,
                                     approves, worker builds it
~06:40 video reaches READY         → autoShorts selects 3 moments,
                                     worker encodes them (no model cost)
08:30  release cadence slot 1      → reel 1 published
12:30  release cadence slot 2      → reel 2 published
14:00  schedule autoPublish        → long video published
18:30  release cadence slot 3      → reel 3 published
```

The long video is generated eight hours before it publishes, deliberately: a
generation that fails at 06:00 leaves time to notice and retry before the slot
it was meant for, and reel selection needs the finished render to exist.

## Part 4 — what it costs

Per channel per day, generation only, at the ~$0.05 an image `story-beats.ts`
uses:

| Channel | Long video | Pictures | Images | Reels |
| --- | --- | --- | --- | --- |
| Dev Pixel | 5 min doodle at 7s | 43 | ~$2.15 | $0 — re-composed |
| Money Mechanics | 6 min cinematic at ~12s | ~30 | ~$1.50 | $0 |
| KIDO FUN ZONE | 4 min illustrated at 20s | ~12 | ~$0.60 | $0 |

**Roughly $4.25 a day in pictures, plus scripts and narration — call it $6 a
day, about $180 a month**, for 3 long videos and 9 reels every day.

The reels are the reason that number is not four times larger, and it is worth
stating plainly: **cutting reels from the long video is a 4× cost difference and
zero quality difference**, because the clips are the same clips.

**Against the $20 gateway cap this account hit yesterday, $6 a day is three and
a half days.** The budget must be raised before this cadence starts, and the
right number is a monthly one — this plan is a standing $180/month commitment,
not a one-off.

## Part 5 — the order to do it in

1. **Raise the gateway budget.** Nothing below works without it, and the failure
   mode is the one already seen: every image call returns 402 and the operator
   reads it as a glitch.
2. **Set each channel's style** per Part 1. Dev Pixel and KIDO FUN ZONE are
   already right. Money Mechanics needs its long-form script style chosen — it
   currently carries `insight-short`, which cannot produce a long video.
3. **Add `DAILY`** to `ScheduleFrequency`, with the migration.
4. **Add `Schedule.autoShorts`**, firing reel selection on `READY`.
5. **Create three release cadences** with the slots in Part 2.
6. **Run one channel for a week** with `autoPublish` off, publishing by hand,
   and watch what comes out.
7. **Replace the slots with measured ones** from
   `channel-analytics.service.ts` once there are two weeks of data.

Step 6 is not caution for its own sake. Twelve items a day published
automatically across three real channels is a lot of output to be wrong about,
and the schedules on these channels were already paused once today because they
would have published a style change nobody had reviewed.

## What this plan does not do

- **No per-video style variation.** Each channel has one look. Rotating styles
  within a channel is the opposite of what a channel is.
- **No topic planning.** `ScheduleTopic` exists and a daily cadence will drain a
  topic bank fast — 365 topics a year per channel — but that is a content
  problem rather than an automation one and it deserves its own document.
- **No cross-channel scheduling.** Three independent cadences, no shared queue.
- **No analytics-driven slot tuning in code.** Step 7 is a human reading a
  dashboard and editing three arrays, not a feedback loop. A loop that moved
  publish times on its own would be very hard to reason about the first time a
  video underperformed for an unrelated reason.
