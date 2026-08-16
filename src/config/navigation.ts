import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  Clapperboard,
  FileText,
  Image,
  KeyRound,
  LayoutDashboard,
  Library,
  Mic,
  MonitorPlay,
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
        icon: Sparkles,
        keywords: ["one click", "pipeline", "generate"],
        built: true,
      },
      {
        title: "Series",
        href: "/automation/series",
        icon: Clapperboard,
        keywords: ["show", "recurring", "schedule", "cadence", "format", "recipe"],
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
