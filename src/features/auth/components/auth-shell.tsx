import type { ReactNode } from "react";

import { LogoMark } from "@/components/brand/logo-mark";

interface AuthShellProps {
  /** One line under the wordmark saying what this page is for. */
  subtitle: string;
  children: ReactNode;
  /** Fine print below the card — links to the other auth pages, usually. */
  footer?: ReactNode;
}

/**
 * The centered card layout every page under (auth) shares. Extracted when the
 * second page appeared: five copies of the same wash-and-wordmark markup drift
 * apart one padding value at a time.
 */
export function AuthShell({ subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden p-6">
      {/* Ambient wash. Purely decorative, so it stays out of the a11y tree. */}
      <div
        aria-hidden="true"
        className="from-primary/10 pointer-events-none absolute inset-0 bg-gradient-to-b via-transparent to-transparent"
      />

      <div className="relative w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-xl shadow-sm">
            <LogoMark className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Framecast</h1>
            <p className="text-muted-foreground text-sm">{subtitle}</p>
          </div>
        </div>

        {children}

        {footer && (
          <div className="text-muted-foreground text-center text-xs text-balance">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
