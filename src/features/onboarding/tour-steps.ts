export interface TourStep {
  /** Matches a `data-tour` attribute in the DOM. A step whose target isn't on
   *  screen is skipped rather than shown pointing at nothing. */
  target: string;
  title: string;
  /** Why this exists, not what it is called. An operator can already read the
   *  label; what they can't see is what the thing is for. */
  body: string;
}

/**
 * The walkthrough a new operator sees once, on their first dashboard visit.
 *
 * ## Five steps, and why it shrank from seven
 *
 * The old tour walked the sidebar: Channels, Providers, Prompt Library,
 * Projects, Videos, one step each. Two problems, and the second is the one that
 * mattered.
 *
 * The first is that it described a smaller app. It sent an operator to /videos
 * to "give a video a topic and approve the script", which is now the long way
 * round — `/automation/generate` writes, approves and queues in one press — and
 * it never mentioned automations, series, shorts drips, channel branding, art
 * styles or analytics, because none of them existed when it was written.
 *
 * The second is that pointing at the sidebar is pointing at nothing on a phone.
 * The sidebar does not render below `md`; the dock does. So the old tour
 * refused to run at all under 768px — the whole first-run experience, absent,
 * on the device an operator is most likely to sign up from.
 *
 * The fix is not a longer tour. Thirty steps explaining twenty screens is worse
 * than seven, and nobody reads it. It is a *shorter* one that does exactly one
 * job — get this person to their first video — and then hands off to the
 * per-screen hints (see help-topics.ts), which explain each screen at the
 * moment somebody actually opens it. Step four is where that handoff is said
 * out loud, because a person who does not know the hints exist will not wait
 * for them.
 *
 * Every target below is either on the dashboard itself or in the top bar, both
 * of which exist at every width. `tour-nav` is on the sidebar *and* on the
 * dock; exactly one of them is ever rendered, and the tour points at whichever
 * it finds.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    target: "tour-welcome",
    title: "Framecast makes the whole video",
    body:
      "Give it a subject and it writes the script, records the narration, " +
      "finds or draws the footage, burns in captions, renders the file and " +
      "makes a thumbnail. Then it stops. Nothing reaches YouTube until you " +
      "press Publish yourself.",
  },
  {
    target: "tour-first-video",
    title: "Start here — it asks two questions",
    body:
      "One-click video wants a channel and a subject, and works the rest out " +
      "from what the channel already says about itself. It will even suggest " +
      "subjects. This is the shortest route to a finished file and the button " +
      "most people press every day.",
  },
  {
    target: "tour-checklist",
    title: "This is your account, not a script",
    body:
      "Each line ticks itself the moment the thing is actually true, and the " +
      "card leaves for good once the last one does. Worth clearing first: a " +
      "run with no ElevenLabs key fails at narration, after the script has " +
      "already been paid for.",
  },
  {
    target: "tour-nav",
    title: "Everything else is in here",
    body:
      "Channels, automations that run without you, publishing, analytics. " +
      "You don't have to learn them now — the first time you open any screen, " +
      "a short note at the top says what it is for. Read it, close it, and it " +
      "never comes back.",
  },
  {
    target: "tour-search",
    title: "Search finds anything, including this",
    body:
      "Jump to any page, or search your videos, scripts, projects, channels " +
      "and prompts by name — ⌘K if you have a keyboard. It is also where this " +
      "tour lives from now on: search for “tour”, or open Settings.",
  },
];
