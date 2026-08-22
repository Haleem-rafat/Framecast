# Style presets

*2026-08-22*

## What this is

A plan for making "make my channel look like that" a thing an operator can
actually ask for.

The prompt was a Short on the operator's own Money Mechanics channel
(`S62_CLND-g8`, 34 seconds, "Europe Redrew the World Map Between Dance
Parties") and the request "add this same style in our platform". The finding
that shapes everything below is that **the platform already produces that
style**. Nothing in it is missing. What is missing is any way to *choose* it.

## What the style actually is

Read off the video rather than off a config, because that Short has no record in
the staging database — it was published by the prod instance, which shares the
YouTube channel.

| Element | What it does |
| --- | --- |
| Frame | 1080x1920, full bleed |
| Length | 34 seconds |
| Pictures | One painterly illustration per beat, held ~4s, ~2 hard cuts in the whole video |
| Captions | **Kinetic** — one to three words at a time, landing on the spoken moment, with one word per phrase highlighted in a coloured box |
| Script | Hook, setup, detail, one-line payoff. "Did you know the peace deal that shaped modern Europe was mostly negotiated between parties and scandals?" … "The chaos produced the stability." |

## Every part already exists

| The style needs | Framecast today |
| --- | --- |
| Vertical composition | `VideoFormat.VERTICAL`, composed natively |
| One still per beat | `planStoryBeats`, either path |
| Painterly stills, no stock | `FootageStyle.ILLUSTRATED` / `CINEMATIC` |
| Kinetic captions | `CaptionMode.kinetic`, `kinetic-captions.ts` |
| A coloured stress word | `CueMeta.emphasis`, already read by the caption writer |
| Hook → payoff in 40s | the single-insight format (`format: "insight"`) |
| Slow cuts, no dissolve | `MotionStyle` / `TransitionStyle` |

So this is not a build. It is a **packaging** problem.

## The actual problem: one look, five places

To reproduce that Short on a new channel today, an operator must set:

1. `ChannelBrand.footageStyle` — a column, on the branding screen
2. `ChannelBrand.artStyle` — a column, on the branding screen
3. `ChannelBrand.beatSeconds` — a column, on the branding screen (new today)
4. `captionMode`, `motion`, `transitions` — fields inside the `videoStyle`
   JSON blob, which `brand.service.ts:106` records the branding screen
   **deliberately does not edit**. There is no UI for these at all.
5. The script format — not stored anywhere. `format: "insight"` is a per-
   generation argument, so it is chosen fresh every time and a channel cannot
   express "I am an insight channel".

Three of those five are reachable from the screen. One has no UI. One has no
column. That is why the style exists and cannot be picked.

## What today already proved

The doodle work built the mechanism for exactly this, without meaning to.
`FORMAT_STYLE_DEFAULTS` in `lib/video-style.ts` is a table of
"what this look wants before the operator says anything", merged **under** the
channel's stored style so an explicit choice still wins. It already carries
three of the five: `motion`, `transitions`, `captionMode`.

It is keyed on `FootageStyle`, which is the limitation. `DOODLE` is a footage
style that happens to imply a caption mode; a *preset* is the other way round —
a named look that implies a footage style, an art style, a cadence, a caption
mode and a script format together.

## The proposal

A `STYLE_PRESETS` catalogue in code, beside `ART_STYLES` and `SCRIPT_STYLES`,
for the same reasons that file gives: the app ships with it whether or not a
seed has run, a channel stores a slug rather than a copy, and improving a
preset improves every channel that named it.

```ts
export interface StylePreset {
  id: StylePresetId;
  name: string;
  description: string;
  footageStyle: FootageStyle;
  artStyle?: ArtStyleId;
  beatSeconds?: number;
  scriptStyleId: string;
  video: Partial<VideoStyle>;
}
```

Two presets to start, because two is what is proven:

- **`insight-short`** — the Short above. `CINEMATIC`, no art style, `insight`
  script format, kinetic captions, slow cuts, vertical.
- **`marker-doodle`** — today's work, moved wholesale out of
  `FORMAT_STYLE_DEFAULTS` so there is one mechanism rather than two.

### Phases

1. **Catalogue and resolution.** `STYLE_PRESETS`, and `brandService.resolve`
   layers a preset under the stored style exactly as `styleBaseFor` does now.
   No schema change, no UI: prove the layering with the two presets and tests.
2. **`ChannelBrand.stylePreset String?`.** Nullable, no default, no backfill —
   the same shape `artStyle` and `beatSeconds` have, for the same reason: a
   default would give every channel one look.
3. **Picker.** `StylePicker` already exists and already takes samples; a preset
   card is the same card. One sample image per preset, generated once and
   committed, as `scripts/generate-style-samples.ts` does for art styles.
4. **Retire `FORMAT_STYLE_DEFAULTS`.** Once `marker-doodle` is a preset, the
   footage-style-keyed table has one caller and should go, or the app has two
   answers to "what does this look want".

### What this must not do

- **Not overwrite the operator's own settings.** A preset is a *base*, merged
  under the stored style. Picking one must never silently clear a channel's
  chosen voice or colours.
- **Not become a second script catalogue.** A preset names a `scriptStyleId`
  from `SCRIPT_STYLES`; it does not carry prompt text.
- **Not hide the parts.** The individual fields stay editable. A preset is a
  starting point somebody can walk away from, not a mode that locks the screen.

## Cost and risk

Cheap in money — no new provider calls beyond one sample image per preset,
about a cent each. The risk is coupling: five settings that used to move
independently now have a thing that moves them together, and the merge order
(`DEFAULT_STYLE` → preset → stored) is what keeps that safe. That order is
already implemented and already tested by `styleBaseFor`'s "loses to an operator
who explicitly asked for motion" case, which is the test to copy.

## Open question for the operator

Whether a preset should also set the **voice**. It is the one remaining element
of "a channel's look" that lives on the brand row, and the Short above clearly
has a chosen one — but a voice is closer to identity than to style, and two
channels using one preset should probably not sound the same. Left out of the
proposal above deliberately, and worth a decision before phase 2.
