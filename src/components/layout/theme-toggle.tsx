"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { updateThemeAction } from "@/actions/settings.action";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ThemePreference } from "@/generated/prisma/enums";

const THEMES = [
  { value: "light", label: "Light", icon: Sun, stored: "LIGHT" },
  { value: "dark", label: "Dark", icon: Moon, stored: "DARK" },
  { value: "system", label: "System", icon: Monitor, stored: "SYSTEM" },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  icon: typeof Sun;
  stored: ThemePreference;
}>;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The server cannot know the resolved theme, so render a stable placeholder
  // until hydration to avoid a mismatch.
  useEffect(() => setMounted(true), []);

  /**
   * Applies the choice, then records it.
   *
   * `setTheme` is what makes the click feel instant — it repaints from
   * `localStorage` with no network involved, exactly as it always did. The
   * write that follows is what makes the choice *portable*: `UserSetting.theme`
   * is read by the dashboard layout on the next page load in any browser, so
   * without it this control would keep being the browser-local toggle whose
   * preference never followed anyone anywhere.
   *
   * Deliberately not awaited and deliberately silent on failure. Nothing the
   * operator can see depends on the result — the theme has already changed —
   * and a toast saying "could not save your theme" over a studio that visibly
   * did change theme is a worse experience than the preference quietly not
   * syncing. It will be written again on the next toggle, or from the settings
   * form.
   */
  function choose(option: (typeof THEMES)[number]) {
    setTheme(option.value);
    void updateThemeAction({ theme: option.stored });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          <Sun className="size-4 scale-100 rotate-0 transition-transform duration-200 dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute size-4 scale-0 rotate-90 transition-transform duration-200 dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        {THEMES.map((option) => (
          // `data-active` tints the row and says nothing else, so which theme
          // is in force was communicated by a background colour alone — the one
          // cue unavailable to a screen reader and the least reliable one for
          // anyone else, given the tint is `bg-accent` on a menu that is itself
          // accent-tinted on hover. `menuitemradio` + `aria-checked` is the
          // role that actually means "one of these three is selected", and it
          // makes the state announced rather than merely painted.
          //
          // `aria-checked` cannot be left undefined before mount — the role
          // requires it — so an unresolved theme reads as unchecked, which is
          // true for the one frame it lasts.
          <DropdownMenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={mounted && theme === option.value}
            onSelect={() => choose(option)}
            data-active={mounted && theme === option.value}
            className="data-[active=true]:bg-accent"
          >
            <option.icon />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
