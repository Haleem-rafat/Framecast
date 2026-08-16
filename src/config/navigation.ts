import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  FileText,
  Image,
  KeyRound,
  LayoutDashboard,
  Library,
  Mic,
  MonitorPlay,
  Repeat2,
  Settings,
  ShieldCheck,
  UserCheck,
  Sparkles,
  Upload,
  Video,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Command palette keywords — matched in addition to the title. */
  keywords?: string[];
  /**
   * Whether `href` resolves to a real page. Unbuilt items stay in this file —
   * the roadmap they describe is intentional — but render disabled with a
   * "Soon" badge instead of linking, so the sidebar never advertises a 404.
   */
  built: boolean;
  /**
   * Hidden from anyone whose role is not OPERATOR — see `visibleNavigation`.
   *
   * This is presentation, never protection: the pages behind these entries
   * gate themselves with `requireOperator()` and would be just as closed if
   * this flag were deleted. What it buys is that a member is never *shown* a
   * door they cannot open. /approvals sat in this list with no such flag while
   * registration was open, so every member's sidebar, ⌘K palette and phone
   * drawer advertised the account queue to them.
   */
  operatorOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Single source of truth for the sidebar, the command palette, and breadcrumb
 * labels. Adding a route here wires it into all three.
 */
export const navigation: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        keywords: ["home", "overview", "today"],
        built: true,
      },
      {
        title: "Analytics",
        href: "/analytics",
        icon: BarChart3,
        // These described the YouTube Analytics integration this page was
        // once planned around. That integration does not exist, so searching
        // "watch time" landed on a page that has never shown one. The page
        // reports what the database actually holds — cost, render timings,
        // throughput — and the keywords now say so.
        keywords: [
          "cost",
          "spend",
          "render time",
          "reliability",
          "failures",
          "throughput",
        ],
        built: true,
      },
      {
        title: "Activity",
        href: "/logs",
        icon: Activity,
        keywords: ["logs", "history", "errors", "audit"],
        built: true,
      },
    ],
  },
  {
    label: "Content",
    items: [
      {
        title: "Projects",
        href: "/projects",
        icon: Library,
        // "series" deliberately not a keyword here any more: it is now a real
        // page of its own, and the palette must not send somebody looking for
        // their shows to the project list.
        keywords: ["folder", "archive"],
        built: true,
      },
      {
        title: "Videos",
        href: "/videos",
        icon: Video,
        keywords: ["draft", "queued", "rendering", "published", "failed"],
        built: true,
      },
      {
        title: "Channels",
        href: "/channels",
        icon: MonitorPlay,
        keywords: ["youtube", "connect", "oauth"],
        built: true,
      },
    ],
  },
  {
    label: "Studio",
    items: [
      {
        title: "Automation",
        href: "/automation",
        icon: Repeat2,
        /**
         * One entry where there were three, because there is now one page.
         *
         * "Series" had a sidebar row of its own and its own keywords, which is
         * how the palette taught the operator that a series and a schedule were
         * different features. They are the same feature — a series is a
         * schedule with a recipe attached — so both vocabularies now land on
         * the one table that lists both. Somebody who types "schedules", the
         * name of a page that no longer exists, gets the page it turned into.
         *
         * The shorts drip's vocabulary is here for the same reason and not
         * because it is the same thing: it releases clips rather than making
         * them. But it is a row in this table, and a search that sent the
         * operator somewhere else would be teaching the split all over again.
         */
        keywords: [
          "series",
          "schedules",
          "show",
          "recurring",
          "cadence",
          "weekly",
          "monthly",
          "topic queue",
          "paused",
          "shorts",
          "clips",
          "drip",
          "release",
          "daily",
        ],
        built: true,
      },
      {
        title: "One-click video",
        href: "/automation/generate",
        icon: Sparkles,
        // The opposite of the entry above it: one video now, no cadence. It
        // keeps a row of its own because it is the single most common reason an
        // operator opens this product, and burying it inside a screen about
        // recurrence is what made the old /automation read as three features.
        keywords: ["one click", "generate", "make a video", "pipeline", "now"],
        built: true,
      },
      {
        title: "Script",
        href: "/studio/script",
        icon: FileText,
        keywords: ["writing", "generate", "versions"],
        built: true,
      },
      {
        title: "Voice",
        href: "/studio/voice",
        icon: Mic,
        keywords: ["tts", "narration", "elevenlabs"],
        built: true,
      },
      {
        title: "Thumbnail",
        href: "/studio/thumbnail",
        icon: Image,
        keywords: ["cover", "image", "art"],
        built: true,
      },
      {
        title: "Publishing",
        href: "/publishing",
        icon: Upload,
        keywords: ["upload", "schedule", "visibility"],
        built: true,
      },
    ],
  },
  {
    label: "Configuration",
    items: [
      {
        title: "Prompt Library",
        href: "/prompts",
        icon: Library,
        keywords: ["templates", "variables"],
        built: true,
      },
      {
        title: "AI Providers",
        href: "/providers",
        icon: KeyRound,
        keywords: ["api keys", "openai", "anthropic", "gemini"],
        built: true,
      },
      {
        title: "Approvals",
        href: "/approvals",
        icon: UserCheck,
        keywords: ["accounts", "pending", "sign up", "register", "approve"],
        built: true,
        operatorOnly: true,
      },
      {
        title: "Admin",
        href: "/admin",
        icon: ShieldCheck,
        keywords: ["users", "accounts", "operator", "system", "totals", "storage"],
        built: true,
        operatorOnly: true,
      },
      {
        title: "Settings",
        href: "/settings",
        icon: Settings,
        keywords: ["theme", "defaults", "storage"],
        built: true,
      },
    ],
  },
];

export const navItems: NavItem[] = navigation.flatMap((group) => group.items);

/**
 * The map as one account may see it.
 *
 * Every navigation surface — sidebar, ⌘K palette, phone drawer — renders this
 * rather than `navigation` directly, so an `operatorOnly` entry is hidden in
 * all three at once instead of in whichever two somebody remembered. A group
 * left with no items disappears rather than rendering as a bare heading.
 *
 * Note what this function is not: it runs in the browser, on data the server
 * sent, and a member who edits the flag in their own devtools gets a link that
 * redirects them straight back out. The gate is `requireOperator()` on the
 * page. This is about not putting a locked door in someone's way.
 */
export function visibleNavigation(isOperator: boolean): NavGroup[] {
  if (isOperator) return navigation;

  return navigation
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.operatorOnly),
    }))
    .filter((group) => group.items.length > 0);
}

/** Longest-prefix match so `/videos/:id` still resolves to the Videos entry. */
export function findNavItemByPath(pathname: string): NavItem | undefined {
  return navItems
    .filter(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)
    .at(0);
}

/**
 * Whether a navigation row should read as the current page.
 *
 * Longest-prefix, not "is a prefix". Every surface used to answer this with a
 * bare `startsWith`, which lights *every* ancestor: standing on
 * `/automation/generate` highlighted both One-click video and Automation, so
 * two rows claimed to be where you were and neither was wrong on its own terms.
 *
 * Deferring to `findNavItemByPath` means one row is lit at a time and it is the
 * most specific one — and that the sidebar, the phone dock and the drawer can
 * no longer drift apart, which they had, each carrying its own copy of the rule.
 * A path under no entry at all lights nothing rather than lighting the shortest
 * href that happens to prefix it.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  return findNavItemByPath(pathname)?.href === href;
}
