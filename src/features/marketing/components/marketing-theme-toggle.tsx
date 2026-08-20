"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { updateThemeAction } from "@/actions/settings.action";
import { Button } from "@/components/ui/button";
import { useMarketingAccount } from "@/features/marketing/components/marketing-account";

/**
 * A single button rather than the studio's three-way `ThemeToggle`.
 *
 * The dropdown version pulls Radix's menu primitives into the bundle, and the
 * pages that share this shell include the privacy policy and terms — documents
 * Google fetches during OAuth review and which have no business shipping a menu
 * runtime to render a wall of text. Visitors who want "follow my system" are
 * already getting it: that is the default until this button is pressed.
 *
 * Both icons are always rendered and swapped by the `dark` class in CSS, so
 * there is nothing theme-dependent in the server-rendered markup to mismatch on
 * hydration.
 *
 * ## Why this button writes to the database and the one on reactbits' does not
 *
 * It used to only call `setTheme`, which writes `localStorage` and nothing
 * else, and that made the theme *unstable across the two halves of the site*.
 * `UserSetting.theme` is authoritative for a signed-in operator: the script in
 * `providers/appearance.tsx` runs on every dashboard load and, finding
 * `localStorage` disagreeing with the column, overwrites storage and re-applies
 * the column's class during parse. So switching to dark out here and then
 * opening the studio switched it straight back to light, and coming back to
 * the landing page kept the reverted value — the choice looked like it had not
 * been taken at all.
 *
 * Persisting here closes that loop from the other end. The write is fired and
 * forgotten for the same reason `ThemeToggle`'s is: the theme has already
 * changed on screen, and a toast about a failed preference save over a page
 * that visibly did change is worse than the preference quietly not syncing.
 *
 * A signed-out visitor writes nothing, because there is no row to write to —
 * `updateThemeAction` calls `requireSession()` and would refuse. Their choice
 * lives in `localStorage` exactly as before, and nothing ever overrides it,
 * since the script that would is only rendered by the dashboard layout.
 */
export function MarketingThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const { user } = useMarketingAccount();

  function toggle() {
    const next = resolvedTheme === "dark" ? "light" : "dark";

    setTheme(next);

    if (user) {
      void updateThemeAction({ theme: next === "dark" ? "DARK" : "LIGHT" });
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Switch between light and dark"
      onClick={toggle}
    >
      <Sun className="size-4 scale-100 rotate-0 transition-transform duration-200 dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute size-4 scale-0 rotate-90 transition-transform duration-200 dark:scale-100 dark:rotate-0" />
    </Button>
  );
}
