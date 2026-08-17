import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TOUR_STEPS } from "@/features/onboarding/tour-steps";

/**
 * The failure this file exists to prevent, stated plainly: the old tour spent
 * months describing controls that were no longer on screen. Five of its seven
 * steps pointed at sidebar rows by href, so a route being renamed, moved or
 * merged left the tour narrating an empty margin — and nothing failed, because
 * the tour's own "skip a target that isn't there" rule turned a broken step
 * into a silent one.
 *
 * So the source tree is the assertion. Every `target` must be spelled out as a
 * `data-tour` attribute somewhere in the app, and every `data-tour` attribute
 * must belong to a step. The second half matters as much as the first: an
 * orphaned attribute is a step somebody deleted and a marker they forgot.
 */

const SOURCE_ROOT = join(process.cwd(), "src");

/**
 * Excludes `$`, which is what keeps the tour's own
 * `[data-tour="${target}"]` selector out of the results — it is the code doing
 * the looking, not a thing to be looked at.
 */
const ATTRIBUTE = /data-tour="([^"$]+)"/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      // Generated Prisma output is large and can never carry JSX.
      return entry === "generated" ? [] : sourceFiles(path);
    }

    return entry.endsWith(".tsx") ? [path] : [];
  });
}

function declaredTargets(): Map<string, string[]> {
  const found = new Map<string, string[]>();

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const contents = readFileSync(file, "utf8");

    for (const match of contents.matchAll(ATTRIBUTE)) {
      const target = match[1];
      found.set(target, [...(found.get(target) ?? []), file]);
    }
  }

  return found;
}

describe("TOUR_STEPS", () => {
  const declared = declaredTargets();

  it("points every step at a marker that exists in the app", () => {
    const missing = TOUR_STEPS.filter((step) => !declared.has(step.target));

    expect(missing.map((step) => step.target)).toEqual([]);
  });

  it("leaves no marker in the app that no step points at", () => {
    const targets = new Set(TOUR_STEPS.map((step) => step.target));
    const orphans = [...declared.keys()].filter((target) => !targets.has(target));

    expect(orphans).toEqual([]);
  });

  it("marks the navigation step in two places, so it survives a phone", () => {
    // The sidebar does not render below `md` and the dock does not render
    // above it. If either marker is lost, the tour skips its own navigation
    // step on exactly one class of device and does so silently — which is how
    // the previous tour came to not run at all under 768px.
    const files = declared.get("tour-nav") ?? [];

    expect(files.some((file) => file.endsWith("app-sidebar.tsx"))).toBe(true);
    expect(files.some((file) => file.endsWith("mobile-dock.tsx"))).toBe(true);
  });

  it("stays short enough to be read", () => {
    // Not an arbitrary cap. The tour has one job — reach a first video — and
    // everything else is a per-screen note (see help-topics.ts). A step added
    // here should have had to argue with this number first.
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(6);
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(2);
  });

  it("gives every step a distinct target and real prose", () => {
    const targets = TOUR_STEPS.map((step) => step.target);
    expect(new Set(targets).size).toBe(targets.length);

    for (const step of TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(40);
    }
  });
});
