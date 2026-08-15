"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { visibleNavigation } from "@/config/navigation";
import { cn } from "@/lib/utils";

/**
 * Everything the dock left out.
 *
 * The dock carries the four destinations an operator uses while away from a
 * desk; this is the full map behind them, and it is a `Drawer` rather than a
 * `Sheet` because it is opened from a control at the bottom of the screen —
 * a panel that rises from the same edge as the thumb that summoned it is the
 * gesture a phone user already knows.
 *
 * It reads `navigation` directly, so a route added there appears here without
 * anyone remembering to. Unbuilt entries stay visible and inert for the same
 * reason they do in the sidebar: the roadmap is deliberate, the 404 is not.
 */
export function MobileNavDrawer({
  open,
  onOpenChange,
  isOperator,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** See `visibleNavigation` — the drawer is the phone's whole site map. */
  isOperator: boolean;
}) {
  const pathname = usePathname();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        // Vaul pins the panel to the bottom of the viewport, which on an
        // iPhone is behind the home indicator.
        className="max-h-[85vh] pb-[env(safe-area-inset-bottom)]"
      >
        <DrawerHeader>
          <DrawerTitle>Navigation</DrawerTitle>
          <DrawerDescription>Every page in the studio.</DrawerDescription>
        </DrawerHeader>

        {/* This is the complete site map on a phone — the counterpart to the
         * desktop sidebar — so it earns a navigation landmark of its own. The
         * label distinguishes it from the dock's "Primary", which is on screen
         * behind this drawer at the same time. */}
        <nav
          aria-label="All pages"
          className="flex-1 overflow-y-auto px-4 pb-4"
        >
          {visibleNavigation(isOperator).map((group) => {
            // An `id` may not contain whitespace, and `aria-labelledby` splits
            // on it — so a group label of two words would silently become a
            // reference to two ids that do not exist. Today's labels are all
            // single words; this is here so adding "Prompt Library" to
            // navigation.ts does not quietly break the association.
            const labelId = `mobile-nav-${group.label.replace(/\s+/g, "-")}`;

            return (
              <div key={group.label} className="mb-4 last:mb-0">
                {/* Tied to its own list rather than left floating above it, so
                 * the group name is announced when entering the list instead of
                 * being read as a stray line of text before it. */}
                <p
                  id={labelId}
                  className="text-muted-foreground px-1 pb-1 text-xs font-medium"
                >
                  {group.label}
                </p>
                <ul aria-labelledby={labelId}>
                  {group.items.map((item) => {
                    const active =
                      pathname === item.href ||
                      pathname.startsWith(`${item.href}/`);

                    return (
                      <li key={item.href}>
                        {item.built ? (
                          <Link
                            href={item.href}
                            onClick={() => onOpenChange(false)}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              // h-12, not the sidebar's h-8: this list is
                              // operated by a thumb, not a cursor.
                              "flex h-12 items-center gap-3 rounded-lg px-3 text-sm [&_svg]:size-4",
                              active
                                ? "bg-accent text-accent-foreground font-medium"
                                : "hover:bg-muted",
                            )}
                          >
                            <item.icon />
                            {item.title}
                          </Link>
                        ) : (
                          // Full `text-muted-foreground`, not `/60`. The token is
                          // already close to the 4.5:1 floor against this
                          // surface; at 60% alpha it composites to roughly 2.5:1,
                          // which is a failure on what is still a real page name.
                          // The "Soon" badge beside it already carries the
                          // "you cannot go here" meaning, so the extra fade was
                          // saying the same thing a second time in the one
                          // register that costs legibility.
                          <span className="text-muted-foreground flex h-12 items-center gap-3 px-3 text-sm [&_svg]:size-4">
                            <item.icon />
                            {item.title}
                            <Badge variant="secondary" className="ml-auto">
                              Soon
                            </Badge>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {/* The topbar gives up its theme control on a phone — 375px of bar
           * is worth more spent on the page title. This is where it went. */}
          <div className="mt-2 flex h-12 items-center justify-between border-t px-3 pt-2 text-sm">
            Appearance
            <ThemeToggle />
          </div>
        </nav>
      </DrawerContent>
    </Drawer>
  );
}
