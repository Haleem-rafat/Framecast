import { describe, expect, it } from "vitest";

import { findNavItemByPath, isNavItemActive, navItems } from "@/config/navigation";

/**
 * The bug these cover: every navigation surface answered "is this row the
 * current page" with a bare `startsWith`, which lights every *ancestor* of the
 * path. Standing on `/automation/generate` highlighted both One-click video and
 * Automation — two rows each claiming to be where you were.
 *
 * The rule is longest-prefix, so exactly one row is lit and it is the most
 * specific. The nested pair below is real, not a fixture: `/automation` and
 * `/automation/generate` are both entries, which is what made this visible.
 */
describe("isNavItemActive", () => {
  it("lights only the most specific entry when one nav href is under another", () => {
    expect(isNavItemActive("/automation/generate", "/automation/generate")).toBe(true);
    expect(isNavItemActive("/automation/generate", "/automation")).toBe(false);
  });

  it("lights the parent when the path is not a nav entry of its own", () => {
    // Detail and create routes have no entry, so they belong to their section.
    expect(isNavItemActive("/automation/series/abc-123", "/automation")).toBe(true);
    expect(isNavItemActive("/videos/abc-123", "/videos")).toBe(true);
  });

  it("lights the entry exactly, not a sibling sharing its prefix", () => {
    // `/logs` must not light for `/logsomething`, which `startsWith` alone does.
    expect(isNavItemActive("/logsomething", "/logs")).toBe(false);
  });

  it("lights nothing for a path under no entry", () => {
    expect(navItems.every((item) => !isNavItemActive("/nowhere", item.href))).toBe(true);
  });

  it("never lights two rows at once, for any entry's own path", () => {
    for (const item of navItems) {
      const lit = navItems.filter((one) => isNavItemActive(item.href, one.href));
      expect(lit.map((one) => one.href)).toEqual([item.href]);
    }
  });
});

describe("findNavItemByPath", () => {
  it("resolves a nested path to its section", () => {
    expect(findNavItemByPath("/videos/abc-123")?.href).toBe("/videos");
  });

  it("prefers the deeper entry over its ancestor", () => {
    expect(findNavItemByPath("/automation/generate")?.href).toBe("/automation/generate");
  });

  it("returns nothing for a path outside the map", () => {
    expect(findNavItemByPath("/nowhere")).toBeUndefined();
  });
});
