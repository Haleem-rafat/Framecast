# Landing page v2

*2026-08-23*

## What this is

A restructure of `/` against the four-block structure in the
`assessment-landing-page` skill, which encodes Daniel Priestley's
lead-generation system.

The page today is well written and well built. It is also, structurally, a
brochure: eight sections that describe the product accurately and never once
name the reader's problem. This document is the audit that produced that
judgement and the plan to fix it.

## The audit

| Block the structure requires | What the page has today | Verdict |
| --- | --- | --- |
| **Hook** — the reader's frustration, or a readiness question | *"Type a topic. Get a finished video."* | **Missing.** Describes the product's mechanism. A reader who is not already sold does not appear in it |
| **Value proposition** — three things measured and improved | A features grid: prompt templates, ElevenLabs narration, footage matched line by line, music and motion… | **Missing.** Features, not outcomes, and there are eight of them rather than three |
| **Credibility** — who made it, track record, research | Nothing. No bio, no numbers, no evidence | **Missing entirely** |
| **CTA** — next step, duration, price, immediate payoff | *"Create your first video"* + *"Sign in"* | **1 of 4.** Names the step; says nothing about how long, what it costs, or what happens next |

Four blocks, none of them fully present. That is the finding, and it is not a
criticism of the writing — the sentences are good. The page is answering
"what is this?" when the reader is asking "is this for me?"

### The thing the page already does better than most

*"And it stops twice, for you. Nothing runs until you have approved the script.
Nothing publishes until you have watched the finished video."*

That is the strongest sentence on the page and it survives v2 untouched. It is
the difference between this product and "an AI posts to my channel
unsupervised", and `page.tsx` already carries a comment asking that any editor
keep the hero and the pipeline saying it. This plan keeps both.

## What v2 changes

### Block 1 — the hook

A **frustration hook**, because the audience has one and it is specific. The
"even though" clause is the mechanism: it names the effort the reader is
already making, so the sentence stops blaming them.

> # Your channel needs three videos a week. You have a full-time job.
>
> Not a shortage of ideas. Not a shortage of effort. A shortage of the eleven
> hours a week it takes to script, record, edit and upload them.

The old headline moves down rather than being deleted — *"Type a topic. Get a
finished video."* is a good mechanism sentence, and a mechanism sentence is
what Block 2 opens with.

### Block 2 — the value proposition, as three things

Replaces the eight-tile feature grid **at the top of the page** with three
named outcomes. The grid stays, further down, where features belong.

> **Type a topic. Get a finished video.** Framecast measures and improves the
> three things that decide whether a channel grows:
>
> - **Your output** — one topic in, a finished, published video out. Three a
>   week without three evenings.
> - **Your consistency** — a daily schedule that runs whether or not you are at
>   the keyboard, and reels cut from every long video automatically.
> - **Your cost per video** — every generation priced and recorded against the
>   video that spent it, so you know the number instead of guessing it.

Three, because the structure says three, and because a reader can hold three.
Each is an outcome the reader wants, not a component the product has.

### Block 3 — credibility, which does not exist yet

The hardest block, because it cannot be written from nothing. What is
honestly available:

- **What it actually does end to end** — script, narration, footage, render,
  metadata, thumbnail, shorts, upload. Not a claim; a list of stages that run.
- **Real numbers from the system itself.** The pipeline is instrumented:
  per-video cost is recorded in `ProviderUsage`, and the app knows how long a
  render takes. A page that says *"a five-minute video costs about $2.15 of
  generation and renders in under an hour"* is making a checkable claim.
- **The gates**, as evidence of judgement rather than as a feature.

What must **not** go here: invented testimonials, fake logos, "trusted by
thousands", or any number nobody measured. The skill is explicit that
credibility is not a logo wall, and a fabricated one is worse than an empty
section — it is the one thing on the page a reader can catch.

**Decision: build the block, fill it with what is true, and leave the operator
a marked place for a bio.** A `<CredibilityNote>` with the founder's name and
background is a two-line edit when he wants it; inventing one is not mine to do.

### Block 4 — the CTA, with all four elements

Today: *Create your first video.* Which is the right verb and nothing else.

> **Create your first video**
> Free while it is in beta · about 20 minutes from topic to finished file ·
> you approve the script before anything is spent

- **Next step, named as itself** — unchanged, it was already right
- **How long** — the honest number, not a flattering one
- **Price** — "free while in beta", which is what is true
- **Immediate payoff** — the approval gate, which is also the reassurance

Both the hero CTA and the closing `LandingCta` carry the same four, because a
reader who scrolls to the bottom is the one who needed longer to decide.

## What v2 does not do

- **No assessment funnel.** Parts 2 and 3 of the skill — the 15 questions and
  the dynamic results — describe a lead-capture product, not a landing page
  restructure. Building a scorecard for Framecast is a product decision worth
  its own document, and doing it badly is worse than not doing it.
- **No new components below the fold.** Pipeline, features, output, studio,
  pricing and FAQ are good and stay. They move, they do not change.
- **No invented credibility.** See above.
- **No removal of the approval-gate language.** `page.tsx` asks for it to be
  kept in the hero and the pipeline. It is kept in both.

## The new order

```
Hero              hook + subheading + CTA(4) + the "stops twice" box
ValueProp   NEW   the mechanism sentence + three measured outcomes
Credibility NEW   what it does, what it costs, what it refuses to do
Pipeline          unchanged
Features          unchanged
Output            unchanged
Studio            unchanged
Pricing           unchanged
Faq               unchanged
Cta               CTA(4) instead of CTA(1)
```

Two new components, two rewritten, six untouched.

## Testing

The landing page has no behaviour to unit-test, and this repo's `.test.tsx`
convention is to cover the pure functions behind a component rather than the
render. What is worth pinning is the **copy contract**, because it is exactly
what a later edit erodes without noticing:

- The hero contains an "even though"-shaped frustration clause.
- The value proposition names exactly **three** outcomes — not two, not five.
- Both CTAs carry all four elements: the action, a duration, a price and a
  payoff.
- The approval-gate sentence still appears in the hero and the pipeline, which
  is the promise `page.tsx`'s comment asks an editor to keep.

Four assertions over the rendered strings, in `landing-copy.test.ts`, reading
the copy from one exported constant per block so the test and the page cannot
drift.
