import "server-only";

import { visibleNavigation, type NavItem } from "@/config/navigation";
import { HELP_TOPICS, type HelpTopic } from "@/features/onboarding/help-topics";

/**
 * Every screen in the studio, explained, in sidebar order.
 *
 * ## Why this composes rather than holds content
 *
 * `help-topics.ts` already contains a note per screen, written to be read at
 * the moment somebody opens that screen. Twenty-six of them exist and they are
 * already tested for coverage. Writing a second set of explanations for a
 * guides page would mean two descriptions of every screen, free to disagree —
 * and the one nobody is looking at would be the one that rots.
 *
 * So this pairs each navigation entry with its note. `config/navigation.ts` is
 * already the single source of truth for the sidebar, the command palette and
 * the breadcrumbs; making it the source for the guide too means the page reads
 * in exactly the order an operator sees in the sidebar. "Tab by tab" is
 * literal here rather than an approximation somebody has to maintain.
 *
 * ## What a missing note means
 *
 * A built screen with no topic is a real gap and appears in the returned
 * `missing` list, which `guides.test.ts` asserts is empty. That is what stops
 * this page silently shrinking as screens are added — the failure mode the
 * old five-screen tour had, and the reason this whole area was rebuilt.
 *
 * Unbuilt entries (`built: false`) are skipped rather than reported: they are
 * a roadmap the sidebar deliberately shows as "Soon", and a guide to a page
 * that does not exist would be worse than its absence.
 */

export interface GuideEntry {
  item: NavItem;
  topic: HelpTopic;
}

export interface GuideSection {
  label: string;
  entries: GuideEntry[];
}

export interface Guide {
  sections: GuideSection[];
  /** Built, visible screens with no note. Should always be empty; the test
   *  fails the build if it is not. */
  missing: string[];
}

/**
 * Finds the note written for exactly this screen.
 *
 * Deliberately an exact-pattern match, not the prefix match `resolveHelpTopic`
 * uses. That function answers "what should this URL show", so `/videos/abc`
 * correctly falls back to the `/videos` note. A guide listing every screen
 * wants the opposite: if `/studio/voice` has no note of its own, that is a gap
 * to report, not a reason to print the `/studio` note under a second heading.
 */
function noteFor(href: string, isOperator: boolean): HelpTopic | null {
  return (
    HELP_TOPICS.find(
      (topic) =>
        topic.pattern === href && (!topic.operatorOnly || isOperator),
    ) ?? null
  );
}

export function buildGuide(isOperator: boolean): Guide {
  const sections: GuideSection[] = [];
  const missing: string[] = [];

  for (const group of visibleNavigation(isOperator)) {
    const entries: GuideEntry[] = [];

    for (const item of group.items) {
      // The sidebar shows these disabled with a "Soon" badge. Nothing to
      // explain yet, and explaining it would advertise a 404.
      if (!item.built) continue;

      const topic = noteFor(item.href, isOperator);

      if (!topic) {
        missing.push(item.href);
        continue;
      }

      entries.push({ item, topic });
    }

    // A group whose every entry is unbuilt renders as an empty heading
    // otherwise.
    if (entries.length > 0) {
      sections.push({ label: group.label, entries });
    }
  }

  return { sections, missing };
}
