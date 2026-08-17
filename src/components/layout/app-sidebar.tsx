"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { LogoMark } from "@/components/brand/logo-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { isNavItemActive, visibleNavigation } from "@/config/navigation";
import { UserMenu } from "@/components/layout/user-menu";
import type { SessionUser } from "@/lib/auth";

interface AppSidebarProps {
  user: Pick<SessionUser, "name" | "email" | "image">;
  /** Decides whether the operator-only entries are listed. See `visibleNavigation`. */
  isOperator: boolean;
}

export function AppSidebar({ user, isOperator }: AppSidebarProps) {
  const pathname = usePathname();
  const { isMobile } = useSidebar();

  // Below `md` the floating dock is the navigation, so the sidebar does not
  // render at all — not even as the off-canvas Sheet `Sidebar` would otherwise
  // give it. Two navigations for one app is how you end up with an item that
  // exists in one and not the other, and the Sheet's trigger is gone from the
  // topbar on phones anyway, so leaving it mounted would only mean shipping a
  // panel nothing can open. The desktop sidebar is untouched.
  if (isMobile) {
    return null;
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <LogoMark className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">
                    Framecast
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    Automated production
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* `Sidebar` is a stack of plain `<div>`s, so the studio's primary
       * desktop navigation was reaching assistive tech as unlabelled generic
       * content — no landmark to jump to, nothing in the landmarks list. The
       * role goes here rather than on the `Sidebar` root because the root also
       * wraps the header wordmark and the account menu in the footer, neither
       * of which is navigation. A label is mandatory rather than nicety: the
       * breadcrumb ("breadcrumb") and the mobile dock ("Primary") are already
       * navigation landmarks, and three unnamed ones are worse than none. */}
      {/* The tour's navigation step points here on a desktop, and at the dock
       * on a phone — both carry `data-tour="tour-nav"` and exactly one of them
       * is ever rendered, so the tour highlights whichever this account is
       * actually looking at. */}
      <SidebarContent role="navigation" aria-label="Studio" data-tour="tour-nav">
        {visibleNavigation(isOperator).map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) =>
                  item.built ? (
                    // `data-tour` is how the product tour finds this item to
                    // point at. Keyed on href rather than title so renaming a
                    // nav label doesn't silently break the tour.
                    <SidebarMenuItem key={item.href} data-tour={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isNavItemActive(pathname, item.href)}
                        tooltip={item.title}
                      >
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : (
                    // Not a Link: an unbuilt route has no page, so this must
                    // never be clickable rather than merely styled as if it
                    // weren't.
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        disabled
                        tooltip={`${item.title} — coming soon`}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge>Soon</SidebarMenuBadge>
                    </SidebarMenuItem>
                  ),
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <UserMenu user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
