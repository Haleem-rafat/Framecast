"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Library,
  Monitor,
  Moon,
  MonitorPlay,
  Search,
  Sparkles,
  Sun,
  Video as VideoIcon,
  type LucideIcon,
} from "lucide-react";

import { searchAction } from "@/actions/search.action";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { navigation } from "@/config/navigation";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";
// From `@/lib/search`, never from `@/services/search.service` — the service is
// `server-only` and importing it here would fail the client build.
import {
  MIN_QUERY_LENGTH,
  type SearchGroup,
  type SearchResultType,
} from "@/lib/search";

/**
 * How long the input has to be quiet before a search leaves the browser.
 *
 * Typing "antikythera" is eleven keystrokes; without this it is eleven server
 * actions, five Postgres queries each, whose responses then race each other
 * into the list — the operator watches results for "anti" replace results for
 * "antikyth" because the shorter query finished last. 200ms is under the
 * ~250ms at which a pause starts to feel like lag, and above a fast typist's
 * inter-key gap, so a fluent word costs exactly one query.
 */
const DEBOUNCE_MS = 200;

const RESULT_ICONS: Record<SearchResultType, LucideIcon> = {
  video: VideoIcon,
  script: FileText,
  project: Library,
  channel: MonitorPlay,
  prompt: Sparkles,
};

interface ThemeCommand {
  id: string;
  title: string;
  icon: LucideIcon;
  keywords: string[];
}

const THEME_COMMANDS: ThemeCommand[] = [
  { id: "light", title: "Light", icon: Sun, keywords: ["theme", "appearance"] },
  { id: "dark", title: "Dark", icon: Moon, keywords: ["theme", "appearance"] },
  {
    id: "system",
    title: "System",
    icon: Monitor,
    keywords: ["theme", "appearance", "auto"],
  },
];

/**
 * Substring match over a label and its keywords.
 *
 * cmdk's own fuzzy filter is switched off for this palette (see
 * `shouldFilter={false}` below), so the local commands need a matcher of their
 * own. Deliberately the same rule the server applies to content — a plain
 * case-insensitive substring — so "vid" narrows the navigation list exactly as
 * it narrows the video list, rather than the two halves of one result list
 * disagreeing about what counts as a match.
 */
function matches(query: string, title: string, keywords: string[]): boolean {
  if (query.length === 0) return true;

  const needle = query.toLowerCase();

  return (
    title.toLowerCase().includes(needle) ||
    keywords.some((keyword) => keyword.toLowerCase().includes(needle))
  );
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const router = useRouter();
  const { setTheme } = useTheme();

  /**
   * Monotonic id of the most recent search worth rendering.
   *
   * A server action has no `AbortSignal`, so an in-flight request genuinely
   * cannot be cancelled — but it can be *disowned*. Every dispatch takes the
   * next id and compares it on arrival; anything that is no longer the latest
   * is dropped on the floor. Bumping this on close and on a too-short query as
   * well is what stops a slow response landing in a palette the operator has
   * already moved on from.
   */
  const latestRequest = useRef(0);

  useKeyboardShortcut("k", () => setOpen((previous) => !previous), {
    meta: true,
  });

  const runCommand = useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  // Warm the router cache for top-level routes so palette navigation is
  // instant. Unbuilt routes have no page to prefetch.
  useEffect(() => {
    if (!open) return;
    for (const group of navigation) {
      for (const item of group.items) {
        if (item.built) router.prefetch(item.href);
      }
    }
  }, [open, router]);

  // A palette reopened later must not flash the previous search's results
  // under an empty input.
  useEffect(() => {
    if (open) return;

    latestRequest.current += 1;
    setQuery("");
    setGroups([]);
    setSearching(false);
    setSearchError(null);
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();

    // The minimum length is enforced here as well as in the service, so a
    // one-character query costs no round trip at all rather than a round trip
    // that returns nothing.
    if (trimmed.length < MIN_QUERY_LENGTH) {
      latestRequest.current += 1;
      setGroups([]);
      setSearching(false);
      setSearchError(null);
      return;
    }

    setSearching(true);

    const timer = setTimeout(() => {
      const requestId = (latestRequest.current += 1);

      void searchAction(trimmed).then((result) => {
        // Superseded while in flight: a newer keystroke already owns the list.
        if (requestId !== latestRequest.current) return;

        setSearching(false);
        setGroups(result.ok ? result.data.groups : []);
        setSearchError(result.ok ? null : result.error.message);
      });
    }, DEBOUNCE_MS);

    // Runs on every keystroke, which is the debounce itself: the previous
    // keystroke's request is discarded before it was ever dispatched.
    return () => clearTimeout(timer);
  }, [query]);

  const trimmedQuery = query.trim();

  const navGroups = useMemo(
    () =>
      navigation
        .map((group) => ({
          label: group.label,
          items: group.items.filter(
            // Unbuilt items have no page to jump to — leaving them out is
            // safer than showing a row the operator can still "select".
            (item) =>
              item.built && matches(trimmedQuery, item.title, item.keywords ?? []),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [trimmedQuery],
  );

  const themeItems = useMemo(
    () =>
      THEME_COMMANDS.filter((command) =>
        matches(trimmedQuery, command.title, command.keywords),
      ),
    [trimmedQuery],
  );

  const navCount = navGroups.reduce((total, group) => total + group.items.length, 0);
  const contentCount = groups.reduce(
    (total, group) => total + group.results.length,
    0,
  );
  const totalCount = navCount + themeItems.length + contentCount;

  /**
   * What a screen reader is told after each change.
   *
   * cmdk gives the list `role="listbox"`, each row `role="option"` and drives
   * `aria-activedescendant` from the input — so arrowing through results is
   * announced correctly for free (verified against cmdk 1.1.1's source, not
   * assumed). What it has no concept of is *how many* results arrived, which
   * is the one thing a sighted operator reads instantly from the list's
   * length. This live region is that missing half.
   */
  const announcement = searching
    ? "Searching…"
    : searchError
      ? `Search failed: ${searchError}`
      : totalCount === 0
        ? "No results"
        : `${totalCount} result${totalCount === 1 ? "" : "s"}`;

  return (
    <>
      {/* Below `sm` this is the icon alone at a 44px target: the phone topbar
       * has room for a control, not for a search field that would push the
       * page title off the bar. The dialog it opens is identical either way,
       * and on a phone it is the only way to reach the pages the dock's four
       * slots could not hold. */}
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className="text-muted-foreground relative size-11 justify-center gap-0 p-0 sm:h-9 sm:w-64 sm:justify-start sm:gap-2 sm:px-3 sm:pr-2"
      >
        <Search className="size-4" />
        <span className="hidden text-sm sm:inline">Search…</span>
        <kbd className="bg-muted text-muted-foreground pointer-events-none ml-auto hidden h-5 items-center gap-0.5 rounded border px-1.5 font-mono text-[10px] font-medium sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Jump to a page, run a command, or search your videos, scripts, projects, channels and prompts"
        /* Above the product tour, which portals itself to `z-[100]` — a
         * hundred is higher than the `z-50` every dialog in this app uses, so
         * a palette opened during the tour rendered *underneath* the tour's
         * dimming layer and behind the full-screen div the tour uses to
         * swallow clicks. ⌘K is a global shortcut and an onboarding overlay is
         * not entitled to decide whether it works, so the palette outranks it.
         * (Radix's modal handling does the rest: while the palette is open the
         * tour is marked `aria-hidden` and stops receiving pointer events, so
         * the two cannot fight over a click.) */
        className="z-[110]"
        /* Matching is owned by this component, not by cmdk.
         *
         * Content rows have already been matched by Postgres, and re-scoring
         * them with a fuzzy matcher here would hide the results that justify
         * having a search at all: a video found by a word buried in its script
         * has that word nowhere in the row's own text, so cmdk would score it
         * zero and drop it. Turning the filter off also fixes the ordering the
         * brief asks for — with it on, cmdk re-sorts groups by best score and
         * a strong content match would shove Navigation below the fold. Off,
         * groups render in DOM order, so the fast path stays first always. */
        shouldFilter={false}
      >
        <CommandInput
          placeholder="Search videos, scripts, projects, commands…"
          value={query}
          onValueChange={setQuery}
        />

        <span aria-live="polite" role="status" className="sr-only">
          {announcement}
        </span>

        {/* One rule rather than a class on twenty items: on a touch device
         * every result is a 44px target, and the desktop list keeps the
         * compact rows a keyboard-driven palette wants. */}
        <CommandList className="[@media(pointer:coarse)]:[&_[data-slot=command-item]]:h-11">
          {navGroups.map((group) => (
            <CommandGroup key={group.label} heading={group.label}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`nav:${item.href}`}
                  onSelect={() => runCommand(() => router.push(item.href))}
                >
                  <item.icon />
                  <span>{item.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}

          {themeItems.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Theme">
                {themeItems.map((command) => (
                  <CommandItem
                    key={command.id}
                    value={`theme:${command.id}`}
                    onSelect={() => runCommand(() => setTheme(command.id))}
                  >
                    <command.icon />
                    <span>{command.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {groups.map((group) => {
            const Icon = RESULT_ICONS[group.type];

            return (
              <CommandGroup
                key={group.type}
                // The truncation notice lives in the group's heading rather
                // than in a row of its own: cmdk uses the heading as the
                // group's accessible name, so "showing the first 5" is read
                // out with the group instead of sitting in a decorative row a
                // screen reader would have to stumble into. Never a silent
                // five-of-forty.
                heading={
                  <span className="flex items-baseline justify-between gap-2">
                    <span>{group.label}</span>
                    {group.truncated && (
                      <span className="text-muted-foreground/80 font-normal">
                        first {group.results.length} matches — refine to narrow
                      </span>
                    )}
                  </span>
                }
              >
                {group.results.map((result) => (
                  <CommandItem
                    key={result.id}
                    value={`${result.type}:${result.id}`}
                    onSelect={() => runCommand(() => router.push(result.href))}
                  >
                    <Icon />
                    <span className="min-w-0 flex-1 truncate">{result.title}</span>
                    {result.subtitle && (
                      <span className="text-muted-foreground hidden min-w-0 max-w-[45%] shrink-0 truncate text-xs sm:inline">
                        {result.subtitle}
                      </span>
                    )}
                    {result.status && (
                      <span className="text-muted-foreground shrink-0 font-mono text-[10px] tracking-wide uppercase">
                        {result.status}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}

          {/* cmdk's own `CommandEmpty` only knows "zero items are mounted",
           * which cannot tell a query that is still too short from one that
           * genuinely found nothing — and the two need different words. */}
          {totalCount === 0 && (
            <div className="text-muted-foreground py-6 text-center text-sm">
              {searchError
                ? searchError
                : searching
                  ? "Searching…"
                  : trimmedQuery.length > 0 &&
                      trimmedQuery.length < MIN_QUERY_LENGTH
                    ? `Keep typing — searches start at ${MIN_QUERY_LENGTH} characters.`
                    : "No results found."}
            </div>
          )}

          {/* Content is still loading but local commands already match, so the
           * list is not empty and the block above never renders. Without this
           * the palette looks like it has finished and simply found nothing. */}
          {searching && totalCount > 0 && (
            <div className="text-muted-foreground px-2 py-3 text-center text-xs">
              Searching your content…
            </div>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
