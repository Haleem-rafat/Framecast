import { AppBreadcrumbs, AppPageTitle } from "@/components/layout/app-breadcrumbs";
import { CommandPalette } from "@/components/layout/command-palette";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { SessionUser } from "@/lib/auth";

/**
 * The bar keeps its place on a phone, but not its contents.
 *
 * What it holds below `md` is decided by what moved elsewhere: the sidebar
 * trigger has no sidebar to open (the dock replaced it), the breadcrumb trail
 * collapses to the page title, and the theme control moved into the dock's
 * menu. What is left is where you are, search, and who you are — the three
 * things nothing else on a phone screen answers. At `h-14` that costs 8% of a
 * 667px viewport rather than the 10% the desktop bar was taking.
 */
export function AppTopbar({
  user,
  isOperator,
}: {
  user: Pick<SessionUser, "name" | "email" | "image">;
  /** Passed straight through to the ⌘K palette, which lists the same nav. */
  isOperator: boolean;
}) {
  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur-lg md:h-16">
      <SidebarTrigger className="-ml-1 hidden md:flex" />
      <Separator orientation="vertical" className="mr-2 !h-4 hidden md:block" />

      <div className="hidden min-w-0 md:block">
        <AppBreadcrumbs />
      </div>
      <div className="flex min-w-0 flex-1 md:hidden">
        <AppPageTitle />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <CommandPalette isOperator={isOperator} />
        <div className="hidden md:block">
          <ThemeToggle />
        </div>
        {/* Desktop keeps this in the sidebar footer, which is not rendered on
         * a phone — so the account menu surfaces here instead. */}
        <div className="md:hidden">
          <UserMenu user={user} variant="compact" />
        </div>
      </div>
    </header>
  );
}
