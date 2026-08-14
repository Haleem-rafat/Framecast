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
import { navigation } from "@/config/navigation";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {navigation.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="text-muted-foreground px-1 pb-1 text-xs font-medium">
                {group.label}
              </p>
              <ul>
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
                        <span className="text-muted-foreground/60 flex h-12 items-center gap-3 px-3 text-sm [&_svg]:size-4">
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
          ))}

          {/* The topbar gives up its theme control on a phone — 375px of bar
           * is worth more spent on the page title. This is where it went. */}
          <div className="mt-2 flex h-12 items-center justify-between border-t px-3 pt-2 text-sm">
            Appearance
            <ThemeToggle />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
