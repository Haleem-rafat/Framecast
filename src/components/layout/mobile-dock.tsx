"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu } from "lucide-react";

import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import type { FloatingDockItem } from "@/components/ui/floating-dock";
import { navItems } from "@/config/navigation";

/**
 * The dock is the one thing in the studio that pulls in `motion`.
 *
 * This component is mounted by the dashboard layout on every authenticated
 * route, so a static import put the whole animation library in the initial
 * bundle of every page — including every desktop page, where the dock is
 * `md:hidden` and its magnification never runs at all. Loading it on demand
 * moves that cost off the critical path: nothing about the first paint depends
 * on it, and on a phone it resolves long before a thumb reaches the bar.
 *
 * `ssr: false` is safe here specifically because the dock is `position: fixed`
 * — it is out of flow, so arriving a frame late moves nothing else on the page.
 */
const FloatingDock = dynamic(
  () => import("@/components/ui/floating-dock").then((m) => m.FloatingDock),
  { ssr: false },
);

/**
 * The four destinations that earn a permanent slot on a phone.
 *
 * `navigation.ts` lists fifteen entries; a tab bar that tried to show them all
 * would give each one 25px. These four are the ones an operator opens *away
 * from a desk*, which is a much narrower question than which pages matter:
 *
 * - `/dashboard` — the one glance that answers "is anything wrong".
 * - `/videos` — the unit of work, and the only route to a specific video's
 *   status while it is rendering.
 * - `/projects` — the container you pick before doing anything with a video.
 * - `/logs` — the follow-up to the dashboard when the answer was "yes,
 *   something is wrong": why did that render fail.
 *
 * Everything else is desk work and lives behind "More" and ⌘K. Channels is a
 * YouTube OAuth handshake, Providers is pasting API keys, Prompt Library is
 * editing multi-paragraph templates, Approvals and Settings are administration
 * — none of them is a thing anyone does one-handed on a train, and each would
 * have cost a slot one of the four above needed.
 *
 * Analytics is the near miss. It is `built`, and "what did last week cost" is
 * a legitimate phone question — but the page is charts and a table, which is a
 * bad trade for a 375px screen when the same tap count reaches it via More.
 *
 * EXTENSION POINT: `/automation` is `built: false` today. When one-click
 * generate lands it is the strongest candidate for this list — it is the one
 * genuinely mobile action in the product, "start a video from my phone" — and
 * adding its href here is the whole change. Something has to leave when it
 * does; `/projects` is the one to drop.
 */
const DOCK_HREFS = ["/dashboard", "/videos", "/projects", "/logs"] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The studio's primary navigation below `md`, where the sidebar does not
 * render at all. Fixed to the bottom of the viewport and lifted clear of the
 * home indicator; `main` in the dashboard layout reserves matching space so
 * the dock never covers the last row of a table or a form's submit button.
 */
export function MobileDock() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // Resolved from `navigation` rather than restated here, so a title or icon
  // change in that file reaches the dock too. An href that stops being
  // `built` drops out on its own instead of shipping a tab that 404s.
  const destinations: FloatingDockItem[] = DOCK_HREFS.flatMap((href) => {
    const item = navItems.find((one) => one.href === href);
    if (!item?.built) return [];

    return [
      {
        title: item.title,
        icon: <item.icon />,
        href: item.href,
        active: isActive(pathname, item.href),
      },
    ];
  });

  const items: FloatingDockItem[] = [
    ...destinations,
    {
      title: "More",
      icon: <Menu />,
      onClick: () => setMenuOpen(true),
      active: menuOpen,
    },
  ];

  return (
    <>
      {/* `pointer-events-none` on the full-width wrapper, re-enabled on the bar
       * itself: the wrapper spans the viewport so the bar can be centred, and
       * without this it would swallow taps on whatever sits either side of the
       * dock — including a button in the last row of the page. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden">
        <FloatingDock
          items={items}
          aria-label="Primary"
          className="pointer-events-auto"
        />
      </div>

      <MobileNavDrawer open={menuOpen} onOpenChange={setMenuOpen} />
    </>
  );
}
