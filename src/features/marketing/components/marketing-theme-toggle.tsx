"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

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
 */
export function MarketingThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Switch between light and dark"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="size-4 scale-100 rotate-0 transition-transform duration-200 dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute size-4 scale-0 rotate-90 transition-transform duration-200 dark:scale-100 dark:rotate-0" />
    </Button>
  );
}
