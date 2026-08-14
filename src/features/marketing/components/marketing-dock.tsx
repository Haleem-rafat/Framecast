"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CircleHelp,
  CreditCard,
  LayoutGrid,
  UserPlus,
  Workflow,
} from "lucide-react";

import {
  FloatingDock,
  type FloatingDockItem,
} from "@/components/ui/floating-dock";

/**
 * The landing page's sections, in the order the page tells them. Each `id`
 * matches a section of `src/app/page.tsx` and the `/#…` anchors in
 * `NAV_LINKS` — the header nav and this dock are two views of one list, and a
 * section added to one has to be added to the other.
 *
 * Root-relative for the same reason the header's are: this shell also renders
 * /privacy, /terms and /contact, where a bare `#pricing` scrolls nowhere.
 */
const SECTIONS = [
  { id: "how-it-works", title: "How it works", icon: Workflow },
  { id: "features", title: "Features", icon: LayoutGrid },
  { id: "pricing", title: "Pricing", icon: CreditCard },
  { id: "faq", title: "FAQ", icon: CircleHelp },
] as const;

/**
 * Which section the visitor is currently reading, or `null` on a page that has
 * none of them.
 *
 * A tab bar whose tabs never light up is a row of buttons, not a navigation —
 * on a phone this dock is the only thing telling someone where they are in a
 * page five screens long, since the header cannot show four section links at
 * 375px. An observer rather than a scroll handler because it costs nothing
 * between crossings, and a band across the middle of the viewport rather than
 * the whole of it because with a full-height root two sections are on screen
 * at once for most of the scroll and the highlight flickers between them.
 */
function useActiveSection(): string | null {
  const pathname = usePathname();
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const elements = SECTIONS.map((section) =>
      document.getElementById(section.id),
    ).filter((element): element is HTMLElement => element !== null);

    if (elements.length === 0) {
      setActive(null);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );

    for (const element of elements) observer.observe(element);

    return () => observer.disconnect();
    // Re-run per page: /privacy has none of these sections, and coming back to
    // the landing page has to re-observe the newly mounted ones.
  }, [pathname]);

  return active;
}

/**
 * The public site's navigation below `md`.
 *
 * The header cannot hold four section links and two account buttons at 375px —
 * today it collapses all six into one hamburger, which is a website's answer.
 * A phone's answer is a bar within thumb reach that shows the sections *and*
 * where you are in them, so the sections move here and the menu keeps what is
 * left: contact and the account actions.
 *
 * "Create an account" takes the last slot rather than "Sign in": this page
 * exists to be read by people who do not have an account yet, and the one who
 * does can reach sign-in from the header on any viewport.
 */
export function MarketingDock() {
  const active = useActiveSection();

  const items: FloatingDockItem[] = [
    ...SECTIONS.map((section) => ({
      title: section.title,
      icon: <section.icon />,
      href: `/#${section.id}`,
      // `active` here is "the section you are reading", which is genuinely the
      // current location on a single-page document — the same claim the dock
      // makes with `aria-current` in the studio.
      active: active === section.id,
    })),
    {
      title: "Create an account",
      icon: <UserPlus />,
      href: "/sign-up",
    },
  ];

  return (
    // Full-width wrapper so the bar can centre, `pointer-events-none` so the
    // half of that wrapper which is not the bar does not eat taps on the page
    // behind it — on this page that would be the pricing cards' buttons.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden">
      <FloatingDock
        items={items}
        aria-label="Sections"
        className="pointer-events-auto"
      />
    </div>
  );
}

/**
 * The dock's own height, as a spacer. The bar is fixed, so without this it
 * covers the footer links on every public page — and the footer is where
 * Privacy and Terms live, which are the two links a compliance reviewer goes
 * looking for.
 */
export function MarketingDockSpacer() {
  return (
    <div
      aria-hidden="true"
      className="h-[calc(4.5rem+env(safe-area-inset-bottom))] md:hidden"
    />
  );
}
