"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronsUpDown, LogOut, Settings } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { signOut } from "@/lib/auth-client";
import type { SessionUser } from "@/lib/auth";
import { getInitials } from "@/utils/format";

interface UserMenuProps {
  user: Pick<SessionUser, "name" | "email" | "image">;
  /**
   * `sidebar` is the full row in the sidebar footer — avatar, name, email.
   * `compact` is the avatar alone, for the phone topbar: the sidebar it
   * normally lives in does not render below `md`, and of everything that bar
   * held, who you are signed in as is the part still worth 44px there.
   */
  variant?: "sidebar" | "compact";
}

export function UserMenu({ user, variant = "sidebar" }: UserMenuProps) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);

    const { error } = await signOut();

    if (error) {
      setIsSigningOut(false);
      toast.error("Could not sign out", { description: error.message });
      return;
    }

    router.push("/sign-in");
    router.refresh();
  }

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "compact" ? (
          <button
            type="button"
            aria-label="Account"
            className="focus-visible:ring-ring/50 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-3"
          >
            <Avatar className="size-8 rounded-full">
              <AvatarImage src={user.image ?? undefined} alt={user.name} />
              <AvatarFallback className="rounded-full">
                {getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
          </button>
        ) : (
          <SidebarMenuButton size="lg">
              <Avatar className="size-8 rounded-lg">
                <AvatarImage src={user.image ?? undefined} alt={user.name} />
                <AvatarFallback className="rounded-lg">
                  {getInitials(user.name)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{user.name}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {user.email}
                </span>
              </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="w-56 rounded-lg"
        // The compact trigger sits in the topbar, so its menu drops down
        // whatever the viewport; only the sidebar row flips to the side.
        side={isMobile || variant === "compact" ? "bottom" : "right"}
        align="end"
        sideOffset={4}
      >
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Signed in as {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="h-11 md:h-auto"
          onSelect={() => router.push("/settings")}
        >
          <Settings />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="h-11 md:h-auto"
          disabled={isSigningOut}
          onSelect={handleSignOut}
        >
          <LogOut />
          {isSigningOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // The sidebar's own markup would be wrong in a topbar — `SidebarMenu` is a
  // `<ul>` sized for the rail — so the compact variant returns the menu bare.
  if (variant === "compact") {
    return menu;
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>{menu}</SidebarMenuItem>
    </SidebarMenu>
  );
}
