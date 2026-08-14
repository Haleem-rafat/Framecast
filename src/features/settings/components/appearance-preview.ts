"use client";

import type { AccentColour } from "@/generated/prisma/enums";
import { ACCENT_STYLE_ID, accentStyleSheet } from "@/lib/accent";

/**
 * Repaints the whole studio in an accent that has not been saved yet.
 *
 * The accent is not a class or an attribute — it is a set of custom properties
 * declared on `:root` by a single server-rendered `<style>` element (see
 * `Appearance`). So previewing one is not a matter of toggling something on a
 * wrapper: it is rewriting that element's rules, which is a one-line operation
 * and instantly correct everywhere, including inside Radix portals that are not
 * in the settings page's subtree at all.
 *
 * That the preview and the real thing go through the same `accentStyleSheet()`
 * is the point. A picker that previews with its own approximation of the accent
 * is a picker that can lie about what Save will do.
 *
 * A no-op if the element is missing, which is the case on any page that is not
 * under the dashboard layout — there is nothing to preview there.
 */
export function previewAccent(accent: AccentColour): void {
  const element = document.getElementById(ACCENT_STYLE_ID);

  if (element) {
    element.textContent = accentStyleSheet(accent);
  }
}
