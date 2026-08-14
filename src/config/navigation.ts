import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  FileText,
  Film,
  Image,
  KeyRound,
  LayoutDashboard,
  Library,
  Mic,
  MonitorPlay,
  Settings,
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
        keywords: ["series", "archive"],
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
        built: false,
      },
      {
        title: "Script",
        href: "/studio/script",
        icon: FileText,
        keywords: ["writing", "generate", "versions"],
        built: false,
      },
      {
        title: "Voice",
        href: "/studio/voice",
        icon: Mic,
        keywords: ["tts", "narration", "elevenlabs"],
        built: false,
      },
      {
        title: "Thumbnail",
        href: "/studio/thumbnail",
        icon: Image,
        keywords: ["cover", "image", "art"],
        built: false,
      },
      {
        title: "Scenes",
        href: "/studio/scenes",
        icon: Film,
        keywords: ["veo", "runway", "kling", "assets"],
        built: false,
      },
      {
        title: "Publishing",
        href: "/publishing",
        icon: Upload,
        keywords: ["upload", "schedule", "visibility"],
        built: false,
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

/** Longest-prefix match so `/videos/:id` still resolves to the Videos entry. */
export function findNavItemByPath(pathname: string): NavItem | undefined {
  return navItems
    .filter(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)
    .at(0);
}
