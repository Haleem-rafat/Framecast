"use client";

import { Coins } from "lucide-react";
import Link from "next/link";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export interface SidebarWallet {
  credits: number;
  /** Operator accounts: never charged. */
  unlimited: boolean;
  /** "Trial", "Creator"… */
  planName: string;
  /** The plan's monthly allowance, for the bar. */
  allowance: number;
}

/**
 * Credits left, always in view, so nobody finds out they have run out at the
 * moment an approval is refused. Red at zero, amber when a long video (5
 * credits) no longer fits. Opens Billing.
 */
export function SidebarCredits({ wallet }: { wallet: SidebarWallet }) {
  const { credits, unlimited, planName, allowance } = wallet;
  const tone = unlimited ? "ok" : credits === 0 ? "empty" : credits < 5 ? "low" : "ok";
  const fill = unlimited ? 100 : Math.min(100, Math.round((credits / Math.max(1, allowance)) * 100));
  const label = unlimited ? "Unlimited credits" : `${credits} credit${credits === 1 ? "" : "s"} left`;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild size="lg" tooltip={label}>
          <Link href="/billing" aria-label={`${label}, ${planName} plan. Open Billing`}>
            <Coins
              className={cn(
                tone === "empty" && "text-destructive",
                tone === "low" && "text-amber-600 dark:text-amber-400",
              )}
            />
            <span className="grid min-w-0 flex-1 gap-1">
              <span className="flex items-baseline justify-between gap-2 text-xs">
                <span className={cn("font-medium", tone === "empty" && "text-destructive")}>
                  {unlimited ? "Unlimited" : `${credits} credits`}
                </span>
                <span className="text-muted-foreground truncate">{planName}</span>
              </span>
              <span className="bg-muted h-1.5 overflow-hidden rounded-full">
                <span
                  className={cn(
                    "block h-full rounded-full",
                    tone === "empty" ? "bg-destructive" : tone === "low" ? "bg-amber-500" : "bg-primary",
                  )}
                  style={{ width: `${fill}%` }}
                />
              </span>
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
