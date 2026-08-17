/**
 * Telling the script writer who the channel's recurring character is.
 *
 * The defect this exists to fix, observed on a finished render: a kids channel
 * branded ILLUSTRATED with the brief "Pip, a small round bear cub…" was given
 * the topic "the little lantern who was afraid of the dark". The script came
 * back "Meet Pip, a brass lantern with…" — the writer had never been told a
 * recurring character existed, so it treated "Pip" as a free-floating name and
 * hung it on whatever the topic was about. The illustrator, which *is*
 * conditioned on the character sheet, correctly drew a bear cub holding a
 * lantern, and for 142 seconds the narration called a bear a lantern.
 *
 * The two halves of the pipeline read different inputs and that is the whole
 * bug: `FootageService.collectIllustrated` reads `ChannelBrand.characterBrief`
 * and `characterSheetPath`; `ScriptService.generate` read neither. This module
 * is the writer's half of that pair, and it is deliberately the *same* text the
 * operator wrote for the illustrator rather than a second field they would have
 * to keep in sync — two descriptions of one character are two chances for the
 * words and the pictures to disagree, which is the failure being fixed.
 *
 * A plain module rather than something inside `script.service.ts` so the
 * wording can be read, reviewed and tested on its own: it is a prompt, and a
 * prompt is behaviour.
 */

import type { FootageStyle } from "@/generated/prisma/enums";
import { needsCharacterSheet } from "@/lib/footage-styles";

/**
 * The `ChannelBrand` columns this decision needs, and no others.
 *
 * Note what is absent: `characterSheetPath`. See `recurringCharacterInstruction`
 * for why the sheet must not gate this.
 */
export interface RecurringCharacterBrand {
  footageStyle: FootageStyle;
  characterBrief: string | null;
}

/**
 * The instruction to send alongside a script prompt, or `null` when this
 * channel has no recurring character and the prompt must go out exactly as it
 * always has.
 *
 * ## What gates it
 *
 * Two conditions, both required:
 *
 *   1. `needsCharacterSheet(footageStyle)` — `ILLUSTRATED` alone. That helper
 *      is *the* classifier for "this style draws every picture from one
 *      character sheet", so a new `FootageStyle` has to be classified in one
 *      place rather than two. It used to be `isGeneratedFootage`, which was the
 *      same set until `CINEMATIC` arrived: that style generates its pictures
 *      too, but wants a different, unnamed person in every shot, so pinning its
 *      scripts to a recurring protagonist would be exactly the mismatch this
 *      module exists to prevent, in the other direction. `CARTOON` is excluded
 *      deliberately and it was
 *      checked rather than assumed: `FOOTAGE_SEARCH_PLAN.CARTOON` is a stock
 *      search plan (Pixabay's animation filter), `collectIllustrated` — the
 *      only reader of `characterBrief` or `characterSheetPath` in the footage
 *      path — runs for `ILLUSTRATED` only, and `CharacterService.generateSheet`
 *      draws a sheet no cartoon channel will ever pass to anything. A cartoon
 *      channel's stock clips show a different creature every section no matter
 *      what the narration says, so pinning the narration to a character would
 *      make the mismatch *worse*, not better.
 *   2. A non-empty `characterBrief`. Null and whitespace are the same state —
 *      "nobody has written this down" — and there is nothing to say about a
 *      character nobody has described.
 *
 * A `LIVE_ACTION` or `CARTOON` channel, a channel with no brand row at all, and
 * an illustrated channel whose brief is still blank therefore all get `null`
 * here, and the request that goes to the model is byte-for-byte the one it was
 * before this existed.
 *
 * ## Why the character *sheet* is not part of the gate
 *
 * A brief with no sheet yet describes a character the illustrator cannot draw
 * consistently — but withholding the instruction in that state would reintroduce
 * the exact bug. The operator writes the brief, generates a script, then presses
 * "generate character sheet"; gating on the sheet would give that video a script
 * written in ignorance of the character and pictures drawn from it. The video
 * cannot reach a render either way — `collectIllustrated` refuses a channel with
 * no sheet before it spends anything, and names the button to press — so the
 * cost of instructing the writer early is nil and the cost of instructing it
 * late is a whole video whose words and pictures disagree. The brief is the
 * operator's statement of who the protagonist is; the sheet is a rendering
 * detail of when they can be drawn.
 *
 * ## Why there is no series-level character
 *
 * Checked rather than assumed, because the ask raised it: `Series` still has no
 * character field, and the schema comment on `Series.channelId` still says a
 * series cannot override any of the channel's look — naming the character sheet
 * explicitly among what it inherits, and giving the decisive reason, which is
 * that nothing would read an override. That is still true here. Every consumer
 * of the character reaches it through `video -> project -> channel -> brand`,
 * this function included, so a `Series.characterBrief` would be a value the
 * screen displayed and the illustrator ignored — a script about one character
 * over pictures of another, which is this defect again with a different cause.
 * An operator who needs a second protagonist needs a second channel.
 */
export function recurringCharacterInstruction(
  brand: RecurringCharacterBrand | null | undefined,
): string | null {
  if (!brand || !needsCharacterSheet(brand.footageStyle)) {
    return null;
  }

  const brief = brand.characterBrief?.trim();

  if (!brief) {
    return null;
  }

  return buildInstruction(brief);
}

/**
 * The wording, written for someone who has never seen this channel.
 *
 * Every rule below is there because the model got that specific thing wrong, or
 * could plausibly get it wrong the moment the topic pulls the other way:
 *
 *   - Rule 1 pins the *species and role*, not just the name. "Meet Pip, a brass
 *     lantern" kept the name and threw away the bear; naming the character
 *     without fixing what they are would have prevented nothing.
 *   - Rule 2 stops the name being lent to something else in the story, which is
 *     the same failure by a smaller margin.
 *   - Rule 3 is the regression itself, with the resolution stated as an
 *     instruction rather than left to inference: a topic's protagonist becomes
 *     something the recurring character *encounters*. The worked example is
 *     included because an abstract rule about "other characters" is exactly
 *     what the model already failed to derive.
 *   - Rule 4 covers the case rule 3 leaves open — a topic with no obvious place
 *     for the character at all — so the answer is "still their story" rather
 *     than the model quietly choosing for itself.
 *
 * The closing line exists because this arrives as a system instruction beside an
 * operator-authored prompt that this feature must not override: length,
 * structure, tone, section count and the subject itself are still that prompt's
 * to decide.
 */
function buildInstruction(brief: string): string {
  return [
    "This channel has one recurring main character who appears in every video " +
      "it publishes. The pictures for this script are drawn from a single fixed " +
      "reference drawing of that character, so the narration has to be about " +
      "that character and nobody else. If the words describe someone the " +
      "pictures do not show, the finished video contradicts itself.",
    "",
    "Who the character is, in the channel owner's own words:",
    "",
    brief,
    "",
    "Rules about that character, which outrank anything the topic seems to suggest:",
    "",
    "1. The character is exactly what that description says they are. Whatever " +
      "kind of thing they are — a species of animal, a person, a creature, an " +
      "object — does not change, and neither does how they look. If the " +
      "description gives them a name, that is their name.",
    "2. Their name belongs to them alone. Never give it to another character, " +
      "animal or object in the story, and never introduce them as anything " +
      "other than what the description says they are.",
    "3. If the topic names or implies some other main character, that other " +
      "character is a separate thing the recurring character meets, finds, " +
      "helps, or is affected by — it is never the recurring character renamed. " +
      "For example: if the recurring character is a bear cub and the topic is " +
      "\"the little lantern who was afraid of the dark\", write a story about " +
      "the bear cub and a lantern the bear cub finds. The bear cub does not " +
      "become a lantern, and the lantern does not take the bear cub's name.",
    "4. If the topic seems to have no place for the character, tell it as their " +
      "story anyway: they are the one the audience follows through it.",
    "",
    "Everything else you have been asked for — the length, the structure, the " +
      "tone, and the subject of the topic itself — is unchanged by this.",
  ].join("\n");
}
