import { AppBreadcrumbs } from "@/components/layout/app-breadcrumbs";
import { CommandPalette } from "@/components/layout/command-palette";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function AppTopbar() {
  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b px-4 backdrop-blur-lg">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 !h-4" />
      <AppBreadcrumbs />

      <div className="ml-auto flex items-center gap-2">
        <CommandPalette />
        <ThemeToggle />
      </div>
    </header>
  );
}
