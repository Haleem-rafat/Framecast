import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { navItems } from "@/config/navigation";
import { HELP_TOPICS, resolveHelpTopic } from "@/features/onboarding/help-topics";

/**
 * Two questions this file answers, and the second is the one the old tour got
 * wrong.
 *
 * 1. Does every note point at a screen that exists? Checked against the route
 *    tree on disk, not against a list somebody kept in step by hand.
 * 2. Does every screen an operator can navigate to *have* a note? Checked
 *    against `navigation.ts`, which is the same list the sidebar, the palette
 *    and the phone drawer render. A page added to the nav with no note fails
 *    here, which is the only way "onboarding covers the whole app" stays true
 *    a month from now.
 */

const ROUTES_ROOT = join(process.cwd(), "src", "app", "(dashboard)");

/**
 * Whether a `/a/:b/c` pattern names a real page.
 *
 * Walks the App Router directory a segment at a time: a literal must be a
 * directory of that name, and a `:param` must be a `[dynamic]` directory. The
 * last segment has to hold a `page.tsx`, so a route group or a folder of API
 * handlers does not count as a screen.
 */
function routeExists(pattern: string): boolean {
  let directory = ROUTES_ROOT;

  for (const segment of pattern.split("/").filter(Boolean)) {
    if (!existsSync(directory)) return false;

    const entries = readdirSync(directory).filter((entry) =>
      statSync(join(directory, entry)).isDirectory(),
    );

    const match = segment.startsWith(":")
      ? entries.find((entry) => entry.startsWith("[") && entry.endsWith("]"))
      : entries.find((entry) => entry === segment);

    if (!match) return false;

    directory = join(directory, match);
  }

  return existsSync(join(directory, "page.tsx"));
}

describe("HELP_TOPICS", () => {
  it("points every note at a route that exists on disk", () => {
    const broken = HELP_TOPICS.filter((topic) => !routeExists(topic.pattern));

    expect(broken.map((topic) => topic.pattern)).toEqual([]);
  });

  it("has a note for every built page in the navigation", () => {
    // /dashboard is the deliberate exception: the tour and the setup checklist
    // already own that screen, and a third panel explaining it would be the
    // third thing a new operator dismisses before seeing any of their own data.
    const exempt = new Set(["/dashboard"]);

    const uncovered = navItems
      .filter((item) => item.built && !exempt.has(item.href))
      .filter((item) => resolveHelpTopic(item.href, true) === null);

    expect(uncovered.map((item) => item.href)).toEqual([]);
  });

  it("keeps ids and patterns unique", () => {
    const ids = HELP_TOPICS.map((topic) => topic.id);
    const patterns = HELP_TOPICS.map((topic) => topic.pattern);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("says something on every note", () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.title.length).toBeGreaterThan(0);
      expect(topic.body.length).toBeGreaterThan(60);
    }
  });

  it("only links onward to a route that exists", () => {
    const brokenActions = HELP_TOPICS.filter(
      (topic) => topic.action && !routeExists(topic.action.href),
    );

    expect(brokenActions.map((topic) => topic.id)).toEqual([]);
  });
});

describe("resolveHelpTopic", () => {
  it("prefers the deeper note on a detail page", () => {
    expect(resolveHelpTopic("/channels", true)?.id).toBe("channels");
    expect(resolveHelpTopic("/channels/6f1c", true)?.id).toBe("channel-brand");
    expect(resolveHelpTopic("/videos", true)?.id).toBe("videos");
    expect(resolveHelpTopic("/videos/6f1c", true)?.id).toBe("video-detail");
  });

  it("prefers a literal segment over a dynamic one", () => {
    // Both `/automation/series/new` and `/automation/series/:id` match this
    // path and both are three segments long. Getting this wrong would greet
    // somebody on the create form with a note about a show they have not made.
    expect(resolveHelpTopic("/automation/series/new", true)?.id).toBe(
      "series-new",
    );
    expect(resolveHelpTopic("/automation/series/9c2f", true)?.id).toBe(
      "series-detail",
    );
  });

  it("separates the one-click flow from the automations list", () => {
    expect(resolveHelpTopic("/automation", true)?.id).toBe("automation");
    expect(resolveHelpTopic("/automation/generate", true)?.id).toBe("generate");
    // The run-in-progress state of the same page, addressed by query string —
    // the pathname is unchanged, so the note is too.
    expect(resolveHelpTopic("/automation/generate", true)?.id).toBe("generate");
  });

  it("carries a note down into nested routes rather than dropping it", () => {
    expect(resolveHelpTopic("/studio/thumbnail/image/8a11", true)?.id).toBe(
      "studio-thumbnail",
    );
  });

  it("says nothing on the dashboard", () => {
    expect(resolveHelpTopic("/dashboard", true)).toBeNull();
  });

  it("hides operator-only notes from a member", () => {
    expect(resolveHelpTopic("/approvals", true)?.id).toBe("approvals");
    expect(resolveHelpTopic("/admin", true)?.id).toBe("admin");

    // Both pages redirect a member before they render, so this can only ever
    // be belt and braces — but it is the same rule `visibleNavigation` applies,
    // stated in the one other place that enumerates screens.
    expect(resolveHelpTopic("/approvals", false)).toBeNull();
    expect(resolveHelpTopic("/admin", false)).toBeNull();
  });

  it("returns nothing for a path no topic claims", () => {
    expect(resolveHelpTopic("/", true)).toBeNull();
    expect(resolveHelpTopic("/nowhere", true)).toBeNull();
  });
});
