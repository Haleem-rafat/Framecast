/**
 * The four blocks of the landing page, as data.
 *
 * ## Why the copy is a constant and not JSX
 *
 * The page is built to a structure — hook, value proposition, credibility,
 * call to action — and every part of that structure is a claim that erodes
 * quietly. A CTA loses its duration in a tidy-up. A three-item value
 * proposition becomes four because somebody had a fourth idea. A frustration
 * hook gets rewritten into a product description by an editor who thought it
 * read oddly, which it does, because naming somebody's problem always reads
 * oddly next to naming your own features.
 *
 * None of that shows up as a broken build. Pulling the strings out here lets
 * `landing-copy.test.ts` hold the structure to its own rules, so the erosion
 * fails a test instead of quietly costing conversions.
 *
 * See docs/superpowers/specs/2026-08-23-landing-page-v2-design.md, and the
 * `assessment-landing-page` skill for where the structure comes from.
 */

/**
 * Block 1 — the hook.
 *
 * A frustration hook rather than a readiness question, because this audience's
 * frustration is specific and shared, and specific beats abstract.
 *
 * The second sentence is the load-bearing one. The structure calls it the
 * "even though" clause: name the effort the reader is ALREADY making, so the
 * sentence stops reading as an accusation. Without it, "your channel needs
 * three videos a week" is a reader's failure. With it, the problem is the
 * eleven hours, which is not something they can try harder at.
 */
export const HOOK = {
  headline: "Your channel needs three videos a week.",
  headlineEmphasis: "You have a full-time job.",
  /** The "even though" clause. Do not remove it — see above. */
  subheading:
    "Not a shortage of ideas, and not a shortage of effort. A shortage of the eleven hours a week it takes to script, record, edit and upload them.",
} as const;

/**
 * Block 2 — the value proposition.
 *
 * Three things measured and improved, not features. The count is part of the
 * structure: three is what a reader holds, and a fourth is always the one that
 * turns the block back into a feature list.
 *
 * Each `name` is something the reader already wants. Each `detail` says what
 * the product does about it in terms the reader can check.
 */
export const VALUE_PROPOSITION = {
  lead: "Type a topic. Get a finished video.",
  intro:
    "Framecast measures and improves the three things that decide whether a channel grows.",
  outcomes: [
    {
      name: "Your output",
      detail:
        "One topic in, a finished and published video out. Three a week without three evenings.",
    },
    {
      name: "Your consistency",
      detail:
        "A daily schedule that runs whether or not you are at the keyboard, and reels cut out of every long video automatically.",
    },
    {
      name: "Your cost per video",
      detail:
        "Every generation priced and recorded against the video that spent it, so you know the number rather than guessing it.",
    },
  ],
} as const;

/**
 * Block 3 — credibility.
 *
 * The structure asks for three things: who made it, what they have done, and
 * what research it rests on. Only the third is available honestly today, so
 * this block carries checkable facts about the system instead of claims about
 * its authors.
 *
 * ## What is deliberately absent
 *
 * No testimonials, no customer logos, no "trusted by" count, no invented bio.
 * The skill is explicit that credibility is not a logo wall, and a fabricated
 * one is the single thing on a page a reader can catch out. An empty section
 * costs less than a false one.
 *
 * `operatorNote` is the marked place for a real bio. Filling it in is a
 * two-line edit for somebody who can say something true; inventing it is not
 * a thing this file may do.
 */
export const CREDIBILITY = {
  heading: "What it actually does, and what it costs",
  facts: [
    {
      claim: "Eight stages, every video",
      detail:
        "Script, narration, footage, render, metadata, thumbnail, shorts, upload. Not a roadmap — the stages that run, in order, defined in one file.",
    },
    {
      claim: "About $2 of generation for a five-minute video",
      detail:
        "Priced per call and recorded against the video that spent it. The number is on the video's own page, not in a pricing table.",
    },
    {
      claim: "It refuses more than it does",
      detail:
        "No narration until you have approved the script. No upload until you have watched the cut. A render that loses a picture stops rather than publishing a hole.",
    },
  ],
  /** Left empty on purpose. See the note above. */
  operatorNote: null,
} as const;

/**
 * Block 4 — the call to action.
 *
 * Four elements, and the structure is clear that the combination is what
 * converts rather than any one of them: the literal next step, how long it
 * takes, what it costs, and what happens immediately.
 *
 * Every one of these is a commitment. If any stops being true, the fix is the
 * product rather than a softer sentence — a CTA that hedges its own duration
 * has given up the thing that made it work.
 */
export const CTA = {
  /** The literal next action. Not "get started", not "learn more". */
  action: "Create your first video",
  /** How long. The honest number, not the flattering one. */
  duration: "About 20 minutes from topic to finished file",
  /** What it costs. */
  price: "Free while it is in beta",
  /** What happens immediately — which is also the reassurance. */
  payoff: "You approve the script before anything is spent",
} as const;

/**
 * The promise `page.tsx` asks every editor to keep, in one place so that
 * asking is enforceable.
 *
 * It is the most trust-building thing this product can say and the whole line
 * between it and "an AI posts to my channel unsupervised". The hero and the
 * pipeline both say it; the test checks that they still do.
 */
export const APPROVAL_GATES = {
  lead: "And it stops twice, for you.",
  detail:
    "Nothing runs until you have approved the script. Nothing publishes until you have watched the finished video.",
} as const;
