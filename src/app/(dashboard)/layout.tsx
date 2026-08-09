import type { ReactNode } from "react";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireUser } from "@/server/session";

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
        <AppTopbar />
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
