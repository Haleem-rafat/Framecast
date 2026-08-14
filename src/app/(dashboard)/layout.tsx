import type { Viewport } from "next";
import type { ReactNode } from "react";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { MobileDock } from "@/components/layout/mobile-dock";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Appearance } from "@/providers/appearance";
import { requireUser } from "@/server/session";
import { settingsService } from "@/services/settings.service";

/**
 * `viewport-fit=cover` is what makes `env(safe-area-inset-*)` resolve to
 * anything but zero on an iPhone. The dock and everything that clears it are
 * measured against those insets, so without this the dock sits under the home
 * indicator on exactly the devices this layout was built for.
 *
 * Declared here rather than in the root layout because it changes how the page
 * meets the hardware, and only the studio is asking for that: the marketing
 * and auth routes are someone else's surface and inherit the root's viewport
 * untouched.
 */
export const viewport: Viewport = {
  viewportFit: "cover",
};

/**
 * Auth gate for every authenticated surface. Because this is a server
 * component, unauthenticated users are redirected before any page below it
 * renders or fetches.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireUser();

  return (
    <SidebarProvider>
      <AppSidebar
        user={{ name: user.name, email: user.email, image: user.image ?? null }}
      />
      <SidebarInset>
        <AppTopbar
          user={{
            name: user.name,
            email: user.email,
            image: user.image ?? null,
          }}
        />
        <main
          className={[
            "flex min-w-0 flex-1 flex-col gap-6 p-4 md:p-6",
            // The dock is fixed, so it is out of flow and would otherwise sit
            // on top of whatever the page ends with — a table's last row, a
            // form's Save button. This reserves the bar's height (44px item +
            // 8px padding + 12px lift) plus the home indicator beneath it, and
            // it does so once here rather than in every page.
            "pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-6",
            // Every control in the studio is sized for a cursor: the design
            // system's default button is 32px tall and its `sm` is 28px. Rather
            // than annotate a few hundred call sites — and rather than change
            // the buttons themselves, which would resize the desktop app — this
            // raises anything interactive to a 44px target on touch devices
            // only. `pointer: coarse` rather than a width breakpoint, because
            // what matters is the finger, not the viewport.
            "[@media(pointer:coarse)]:[&_[data-slot=button]]:min-h-11",
            "[@media(pointer:coarse)]:[&_[data-slot=button][data-size^=icon]]:min-w-11",
            "[@media(pointer:coarse)]:[&_[data-slot=select-trigger]]:min-h-11",
            // 16px is the threshold below which iOS Safari zooms the whole page
            // in when a field takes focus — the single most website-like thing
            // a form can do on a phone.
            "[@media(pointer:coarse)]:[&_input]:min-h-11 [@media(pointer:coarse)]:[&_input]:text-base",
            "[@media(pointer:coarse)]:[&_textarea]:text-base",
          ].join(" ")}
        >
          {children}
        </main>
      </SidebarInset>

      <MobileDock />
    </SidebarProvider>
  );
}
