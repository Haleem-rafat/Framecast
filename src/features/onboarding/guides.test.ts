import { describe, expect, it } from "vitest";

import { visibleNavigation } from "@/config/navigation";
import { buildGuide } from "@/features/onboarding/guides";

/**
 * The coverage guarantee.
 *
 * The failure this whole area was rebuilt to fix is a guide that silently
 * covers less of the product than the product has: the old tour explained five
 * screens because five screens is what existed on the day somebody wrote it.
 * A page listing "every screen" that quietly lists most of them is the same bug
 * wearing a better name, so the assertion that nothing is missing is the point
 * of this file rather than a detail in it.
 */

describe("buildGuide", () => {
  it("explains every built screen an operator can see", () => {
    const { missing } = buildGuide(true);

    // If this fails, a screen was added to config/navigation.ts and no note was
    // written for it in help-topics.ts. The message names the route.
    expect(missing).toEqual([]);
  });

  it("explains every built screen a member can see", () => {
    const { missing } = buildGuide(false);

    expect(missing).toEqual([]);
  });

  it("reads in sidebar order", () => {
    // "Tab by tab" is only true if the tabs are in the order the operator sees
    // them. Both come from config/navigation.ts, so this asserts they were not
    // re-sorted on the way through.
    const guide = buildGuide(true);
    const nav = visibleNavigation(true)
      .map((group) => group.label)
      .filter((label) =>
        guide.sections.some((section) => section.label === label),
      );

    expect(guide.sections.map((section) => section.label)).toEqual(nav);
  });

  it("hides operator-only screens from a member", () => {
    const member = buildGuide(false);
    const operator = buildGuide(true);

    const hrefs = (guide: ReturnType<typeof buildGuide>) =>
      guide.sections.flatMap((section) =>
        section.entries.map((entry) => entry.item.href),
      );

    expect(hrefs(member).length).toBeLessThan(hrefs(operator).length);
    expect(hrefs(member)).not.toContain("/approvals");
    expect(hrefs(member)).not.toContain("/admin");
  });

  it("skips screens that do not exist yet", () => {
    // Unbuilt entries are a roadmap the sidebar shows as "Soon". A guide to a
    // page that 404s would be worse than no entry at all.
    const guide = buildGuide(true);
    const built = new Set(
      visibleNavigation(true)
        .flatMap((group) => group.items)
        .filter((item) => item.built)
        .map((item) => item.href),
    );

    for (const section of guide.sections) {
      for (const entry of section.entries) {
        expect(built.has(entry.item.href)).toBe(true);
      }
    }
  });

  it("gives every entry something worth reading", () => {
    const guide = buildGuide(true);

    for (const section of guide.sections) {
      expect(section.entries.length).toBeGreaterThan(0);

      for (const entry of section.entries) {
        expect(entry.topic.title.length).toBeGreaterThan(8);
        // A one-line note is a label, not an explanation. Every one of these
        // is meant to say what the screen is for and what is not obvious.
        expect(entry.topic.body.length).toBeGreaterThan(80);
      }
    }
  });
});
