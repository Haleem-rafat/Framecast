import type { ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryProvider } from "@/providers/query-provider";
import { ThemeProvider } from "@/providers/theme-provider";

/**
 * Single composition point for app-wide context. Keeping this a server
 * component means adding a provider never forces the root layout to the client.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <TooltipProvider delayDuration={200}>
          {children}
          {/* Toasts land bottom-right, which on a phone is exactly where the
           * studio's floating dock lives — a toast would cover the navigation
           * for as long as it is on screen, and its close button would be
           * fighting the dock's items for the same taps. `mobileOffset` lifts
           * them clear of the dock and the home indicator below it. */}
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            mobileOffset={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
          />
        </TooltipProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
