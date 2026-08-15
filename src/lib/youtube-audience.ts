/**
 * The audience declaration, in the words an operator has to be able to answer
 * correctly — and in one place, so the two screens that mention it cannot
 * drift apart.
 *
 * Two screens mention it, and they do different jobs. `/channels` asks the
 * question and stores the answer. The publish dialog *states* the answer that
 * is about to be sent, and offers no control at all: this is a legal
 * declaration under COPPA, the US FTC has taken enforcement action against
 * creators who got it wrong, and a toggle inside the one dialog whose button
 * cannot be un-clicked is exactly where a wrong click costs the most. If those
 * two screens described the declaration differently, the operator would be
 * confirming something other than what they set — so both read from here.
 *
 * Plain strings in a client-safe module for the same reason
 * `youtube-categories.ts` is one: both screens are client components and this
 * is text they render on their first frame.
 */

/**
 * YouTube's own help page for the question. Linked rather than paraphrased
 * further: `MADE_FOR_KIDS_TEST` below is a summary, the operator's answer has
 * legal weight, and the authority on the wording is YouTube — not this app's
 * recollection of it.
 */
export const MADE_FOR_KIDS_GUIDANCE_URL =
  "https://support.google.com/youtube/answer/9528076";

/**
 * The label on the control. Deliberately not "Is this for kids?", which reads
 * as "would a child enjoy it" and is answered "well, maybe" by almost any
 * channel. YouTube's question is about whether the content is *directed to*
 * children, which is a different and answerable thing.
 */
export const MADE_FOR_KIDS_QUESTION =
  "Is this channel's content directed to children?";

/**
 * The test itself, summarised from YouTube's guidance so the operator can
 * actually apply it rather than guess at the label above. These are the
 * factors YouTube names: what the content is about, who it is aimed at, and
 * what it puts on screen.
 */
export const MADE_FOR_KIDS_TEST =
  "Judge it the way YouTube does: the subject matter, whether children are " +
  "the intended audience, and whether it features child actors, animated " +
  "characters, toys, games, songs, play-acting or other activities and " +
  "themes aimed at children.";

/**
 * What turning it on actually costs, listed because it is the operator's real
 * trade-off and because none of it is reversible from this app. YouTube
 * applies every one of these to a video declared made for kids, whatever the
 * channel's other settings say.
 */
export const MADE_FOR_KIDS_CONSEQUENCES: readonly string[] = [
  "No personalised ads, which usually means less revenue per view.",
  "Comments are turned off.",
  "Subscribers get no notification when a video goes up.",
  "No end screens, cards, watermarks, Save to playlist, or live chat.",
];

/**
 * One sentence stating which declaration a publish is about to send, for the
 * dialog that states it. Present tense and about the channel, not the video:
 * the declaration is the channel's, and the publish dialog is reporting it
 * rather than asking.
 */
export function audienceStatement(madeForKids: boolean): string {
  return madeForKids
    ? "This channel is declared as made for kids."
    : "This channel is declared as not made for kids.";
}

/**
 * The consequence line that goes with `audienceStatement`, in one sentence.
 * The "not made for kids" side is stated as plainly as the other: an operator
 * about to upload a children's video needs "this is going up as not for kids"
 * to read as a warning, not as the absence of one.
 */
export function audienceConsequence(madeForKids: boolean): string {
  return madeForKids
    ? "YouTube will disable comments and notifications, serve no personalised ads, and limit features on it."
    : "It keeps comments, notifications and personalised ads. If this channel's content is directed to children, this declaration is wrong — change it on the channel before publishing.";
}

/** Short label for a channel card, where there is room for three words. */
export function audienceLabel(madeForKids: boolean): string {
  return madeForKids ? "Made for kids" : "Not made for kids";
}
