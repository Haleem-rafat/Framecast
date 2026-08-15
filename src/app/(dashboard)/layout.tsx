import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { MobileDock } from "@/components/layout/mobile-dock";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Appearance } from "@/providers/appearance";
import { requireUser } from "@/server/session";
import { accountService } from "@/services/account.service";
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
 * Every operator route says "do not index me", in its own markup.
 *
 * robots.ts already disallows these paths, but a `Disallow` is an instruction
 * not to *crawl*, and Google is explicit that a disallowed URL can still be
 * indexed — URL only, no snippet — on the strength of inbound links alone. The
 * two directives are also mutually defeating in the obvious way: a crawler told
 * not to fetch the page never sees a `noindex` in it. So this is not a
 * duplicate of robots.ts, it is the half that applies to a crawler that reached
 * the page some other way, and the pair only works because the paths are
 * genuinely reachable — an unauthenticated fetch here redirects to sign-in and
 * carries this header with it.
 *
 * Declared on the layout rather than on each of the fourteen pages below it:
 * Next.js merges metadata field by field down the tree, and none of those pages
 * declares `robots`, so every one of them inherits this. A route added under
 * this group is noindex the moment it exists, which is the opposite of the
 * hand-maintenance robots.ts needs.
 *
 * `nocache` and the googleBot block undo the root layout's opt-in to large
 * image previews and unlimited snippets — settings that only make sense for the
 * marketing pages that granted them.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

/**
 * Auth gate for every authenticated surface. Because this is a server
 * component, unauthenticated users are redirected before any page below it
 * renders or fetches.
 *
 * It is also where per-operator appearance enters the page, and this layout is
 * the right place for it on both counts. It is the narrowest thing that wraps
 * the whole studio: the root layout would have to resolve a session to do the
 * same job, turning every static marketing page dynamic. And it is exactly the
 * boundary the accent must not cross — `/`, `/privacy` and the auth screens
 * carry their own fixed brand palette under `.marketing`, and never render this
 * layout, so they never see an operator's accent. See `Appearance` for how the
 * two values reach the first painted frame.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireUser();
  const [appearance, role] = await Promise.all([
    settingsService.appearance(user.id),
    accountService.roleFor(user.id),
  ]);

  /**
   * Decides only what the three navigation surfaces *list*. Every
   * operator-only page gates itself with `requireOperator()`, so a member who
   * forges this in devtools gains a link that redirects them straight back
   * out — see `visibleNavigation` in src/config/navigation.ts.
   *
   * `requireUser()` deliberately stays the gate for this layout. Reading the
   * role here is one extra primary-key lookup on every authenticated request,
   * paid in parallel with the appearance read that was already happening, and
   * it is what stops the sidebar advertising the account queue to all 41
   * approved members the way it did before the role existed.
   */
  const isOperator = role === "OPERATOR";

  return (
    <SidebarProvider>
      {/* First in the tree, so the accent stylesheet and the theme sync land
          ahead of every pixel they affect. Renders nothing visible. */}
      <Appearance theme={appearance.theme} accent={appearance.accent} />

      {/* First focusable thing in the document, and invisible until it is
       * focused. Without it a keyboard or switch user arrives on every page
       * behind the sidebar's fifteen nav items plus the topbar's controls, and
       * has to tab past all of them again on the next page — the sidebar is
       * persistent, so the cost is paid per navigation, forever.
       *
       * `sr-only` with a `focus:` escape rather than the usual off-screen
       * `-top-full` trick: `sr-only` already keeps it out of layout without
       * removing it from the accessibility tree, and `focus:not-sr-only` is the
       * one-class undo. z-50 puts it over the sticky topbar, which would
       * otherwise cover it at the moment it becomes visible. */}
      <a
        href="#main-content"
        className="bg-background text-foreground ring-ring sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2"
      >
        Skip to content
      </a>

      <AppSidebar
        user={{ name: user.name, email: user.email, image: user.image ?? null }}
        isOperator={isOperator}
      />
      <SidebarInset>
        <AppTopbar
          user={{
            name: user.name,
            email: user.email,
            image: user.image ?? null,
          }}
          isOperator={isOperator}
        />
        <main
          id="main-content"
          // The skip link above lands here, and a heading-less landing point is
          // a dead end for anyone who cannot see where focus went. -1 makes the
          // element focusable by script and by that link without inserting it
          // into the tab order.
          tabIndex={-1}
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

      <MobileDock isOperator={isOperator} />
    </SidebarProvider>
  );
}
