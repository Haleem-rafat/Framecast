"use client";

import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { getInitials } from "@/utils/format";

/**
 * Who, if anyone, is reading the public site.
 *
 * Read on the client rather than passed down from a server component, and that
 * is the whole decision in this file. Every public page is statically
 * prerendered — nothing in `app/layout.tsx` or the marketing tree touches
 * `cookies()` — so reading the session on the server would opt the landing
 * page, /privacy, /terms and /contact out of static rendering entirely, to
 * personalise two buttons. A visitor with no account (which is who this page is
 * for) would pay a round trip on the site's front door so that the rare
 * signed-in visitor sees the right button a few hundred milliseconds sooner.
 *
 * The cost of doing it this way is `isPending`: for one paint, nobody knows.
 * See `MarketingAccountAvatar`'s callers for which way they resolve that, and
 * why they all resolve it the same way.
 */
export function useMarketingAccount() {
  const { data, isPending } = useSession();

  return { user: data?.user ?? null, isPending };
}

interface MarketingAccountAvatarProps {
  user: { name: string; image?: string | null };
  className?: string;
}

/**
 * A signed-in visitor's way back in: their own face, linking to the studio.
 *
 * Deliberately a link and not the dropdown `UserMenu` the dashboard uses. That
 * component is not portable here — it calls `useSidebar`, so it throws outside
 * the sidebar provider the marketing shell has no reason to mount — but the
 * bigger reason is that its menu offers Settings and Sign out, and neither is
 * what someone who landed on the marketing page came for. They came to get to
 * their work, so this is one tap to exactly that.
 *
 * It points at `/dashboard` rather than at a role-aware destination on purpose:
 * an account still awaiting approval is redirected to /pending by the gate in
 * `server/session.ts`, which is the same answer this would have to compute, and
 * computing it here would be a second copy of it free to disagree.
 */
export function MarketingAccountAvatar({
  user,
  className,
}: MarketingAccountAvatarProps) {
  return (
    <Link
      href="/dashboard"
      aria-label={`Go to your dashboard, signed in as ${user.name}`}
      title="Go to your dashboard"
      className={cn(
        "focus-visible:ring-ring/50 hover:ring-border rounded-full outline-none transition hover:ring-2 focus-visible:ring-3",
        className,
      )}
    >
      <Avatar className="size-8 rounded-full">
        <AvatarImage src={user.image ?? undefined} alt="" />
        <AvatarFallback className="rounded-full text-xs">
          {getInitials(user.name)}
        </AvatarFallback>
      </Avatar>
    </Link>
  );
}
