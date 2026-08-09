# Framecast — Model Selection

**Date:** 2026-08-09
**Scope:** Which model handles which stage, why, and what it costs.

> ⚠️ **Every price here needs verifying before you commit money.** Model pricing changes
> often and I have not confirmed current rates against each provider's pricing page.
> Treat these as order-of-magnitude figures for planning, not quotes. The one number
> that matters is the total per video, and it is dominated by voice, not by text.

---

## 1. The principle

Match model capability to the actual difficulty of the task, not to the importance of
the pipeline. Most stages are easy and high-volume; one stage is genuinely hard.

- **Hard, and worth paying for:** the script. It carries the channel's quality and must
  obey guardrails (no financial advice, cite every claim). Everything downstream inherits
  its quality — a weak script cannot be rescued by good voice or footage.
- **Easy, and should be cheap:** titles, descriptions, tags, scene splitting. These are
  short, structured, and forgiving. Paying frontier prices here is waste.
- **Not a language problem at all:** footage selection, captions, rendering.

## 2. Per-stage selection

| Stage | Model | Why | Approx. cost per video |
|---|---|---|---|
| **Script** | **Claude Sonnet 5** | Best instruction-following for structured, rule-bound writing. The guardrails are the hard part, not the prose. | ~$0.03 |
| **Title / description / tags** | **Claude Haiku 4.5** | Short, high-volume, low-judgement. Roughly a third the cost of Sonnet for output that is indistinguishable here. | ~$0.002 |
| **Scene splitting** | **Claude Haiku 4.5** | Segmenting a script into shots is close to classification. Use structured output so the result is machine-readable. | ~$0.003 |
| **Footage search terms** | **Claude Haiku 4.5** | Turning each scene into stock-search keywords. Trivial task, done many times per video. | ~$0.002 |
| **Voice-over** | **ElevenLabs** (Flash/Turbo tier) | Best available narration quality. This is the single largest cost and the one viewers judge fastest. | **$0.30 – 1.00** |
| **Thumbnail** | An image model — see §4 | Needs bold, high-contrast composition with space for overlaid text. | ~$0.04 |
| **Captions** | **Whisper** (word-level timestamps) | Not generation — alignment. The script text is already known; Whisper supplies timing against the generated audio. | ~$0.01 |
| **Stock footage** | **Pexels + Pixabay APIs** | Not AI. Free, commercial-use licensed. Two sources so clips do not repeat. | free |
| **Rendering** | **FFmpeg** | Not AI. Deterministic assembly on the worker. | ~$0 |
| **AI-generated video** | **deferred** — see §5 | $0.20–0.50 per second of footage. A 5-minute video would cost $60–150. | not used |

**Total per package (1 long video + 3 Shorts): roughly $0.40 – $1.10**, of which voice is
70–90%. Text generation is a rounding error — optimising it saves nothing meaningful.

## 3. Why Sonnet for the script rather than Opus or Haiku

- **Opus 5** is roughly 5× Sonnet's price. For an 8-minute explainer built from a
  well-tuned prompt template, the quality difference does not survive contact with an
  AI narrator and stock footage. Revisit only if scripts are consistently weak *after*
  the prompt has been iterated — prompt quality dominates model choice at this length.
- **Haiku 4.5** is capable, but the script is where the channel's guardrails live:
  no advice, no predictions, sourcing on every claim. Rule-following under a long
  instruction set is exactly where the stronger model earns its cost — and its cost is
  three pence.

The decision reverses if volume rises sharply. At 30 videos/week the script cost is still
under $1/week, so it likely never reverses on cost alone.

## 4. Thumbnail model — decide when we build it

Not settled, and it should not be settled from memory. The requirement is specific:
one clear focal subject, dramatic lighting, saturated colour, generous negative space on
one side, and **no text in the image** — text is overlaid afterwards so it stays sharp
and editable.

Candidates to compare on those criteria when sub-project 2 begins: Google Imagen, OpenAI
image generation, Flux, Ideogram. Ideogram's strength is text rendering, which we
explicitly do not want, so its advantage does not apply here.

Choose by generating the same prompt through each and comparing, not by reputation.

## 5. AI-generated video — deliberately not used

At $0.20–0.50 per second, a 5-minute video costs $60–150 against roughly $1 for stock
footage. That is a 50–100× difference for a format where viewers are watching for the
explanation, not the cinematography.

`AiProviderType` keeps `GOOGLE_VEO`, `RUNWAY`, `KLING`, `PIKA` and `LUMA` so the option
stays open. Reconsider only for short hero shots on videos that already earn — never as
the default path.

## 6. Access

All text and image models route through the **Vercel AI Gateway**: one credential, one
bill, and per-call cost reporting that maps directly onto the `ProviderUsage` table.
ElevenLabs, Pexels and Pixabay are separate accounts with their own keys in the vault.

> **Known defect at time of writing:** `gateway.provider.ts` reads the key from the
> vault's `ANTHROPIC` slot but passes it to `createGateway()`. A genuine Anthropic key
> pasted into that slot would be rejected. The slot must be relabelled, or the provider
> must branch on credential type. Resolve before the Providers page ships.

## 7. What to change if the channel grows

| Signal | Change |
|---|---|
| Scripts feel generic | Iterate the prompt template first. Only then consider Opus 5. |
| Voice cost dominates | Move to ElevenLabs' cheapest adequate tier; it is 70–90% of spend. |
| Publishing many videos daily | Move titles/tags/scenes to batch calls; keep the script model. |
| A video earns well above cost | Consider AI-generated hero shots for that format only. |
