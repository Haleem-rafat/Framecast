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
} from "@/components/ui/sidebar";
import { navigation } from "@/config/navigation";
import { UserMenu } from "@/components/layout/user-menu";
import type { SessionUser } from "@/lib/auth";

interface AppSidebarProps {
  user: Pick<SessionUser, "name" | "email" | "image">;
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({ user }: AppSidebarProps) {
  const pathname = usePathname();

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

      <SidebarContent>
        {navigation.map((group) => (
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
                        isActive={isActive(pathname, item.href)}
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
