export interface TourStep {
  /** Matches a `data-tour` attribute in the DOM. A step whose target isn't on
   *  screen is skipped rather than shown pointing at nothing — the sidebar
   *  collapses on small screens, and half the tour lives there. */
  target: string;
  title: string;
  /** Why this exists, not what it is called. An operator can already read the
   *  label; what they can't see is what the thing is for. */
  body: string;
}

/**
 * The walkthrough a new operator sees once, on their first dashboard visit.
 *
 * Ordered as the work actually flows — set up the account, then make a video,
 * then watch it run — rather than in sidebar order, because the sidebar groups
 * by kind and a newcomer needs the sequence.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    target: "tour-welcome",
    title: "Framecast makes videos while you're away",
    body:
      "You give it a topic. It writes a script, records narration, finds " +
      "footage, burns in captions, and hands you a finished video. Two points " +
      "need your approval — nothing reaches YouTube without you. Here's the " +
      "route through it.",
  },
  {
    target: "/channels",
    title: "First, connect your YouTube channel",
    body:
      "This is where finished videos publish to. Framecast uploads as " +
      "unlisted, so a video is never public the moment it lands — you make it " +
      "public yourself in YouTube Studio when you're happy with it.",
  },
  {
    target: "/providers",
    title: "Then add your narration key",
    body:
      "Narration comes from ElevenLabs and needs your API key. Without it a " +
      "run fails partway through, after the script is already written — so " +
      "it's worth doing before your first video, not after.",
  },
  {
    target: "/prompts",
    title: "This is where you control the writing",
    body:
      "The script prompt decides how your videos sound — the pacing, the " +
      "tone, how a point gets explained. It's the highest-leverage thing on " +
      "this screen. Change it here and every future script follows.",
  },
  {
    target: "/projects",
    title: "Projects group videos that belong together",
    body:
      "A project is usually one series or one channel. It holds the publish " +
      "defaults its videos inherit, so you set them once instead of per video.",
  },
  {
    target: "/videos",
    title: "This is where the work happens",
    body:
      "Give a video a topic and Framecast writes a script. You read it and " +
      "approve it — that's the first gate. Then it queues, and a worker picks " +
      "it up: narration, footage, captions, render. You watch each stage as it " +
      "goes.",
  },
  {
    target: "tour-checklist",
    title: "The checklist tracks what's left",
    body:
      "It reads your real setup, not a script — each item ticks itself once " +
      "you've actually done it, and the whole thing disappears when you're " +
      "ready to produce. Start at the top.",
  },
];
