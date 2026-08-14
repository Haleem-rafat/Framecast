"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, LogOut, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth-client";

/**
 * The only two things someone waiting for approval can usefully do. "Check
 * again" is a `router.refresh()` rather than a link back to this page, because
 * the client router cache would happily serve the same "still pending" render
 * for up to half a minute and make an approval that just landed look like it
 * had not.
 */
export function PendingAccountActions() {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
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

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button
        variant="outline"
        className="flex-1"
        disabled={isRefreshing}
        onClick={() => startRefresh(() => router.refresh())}
      >
        {isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Check again
      </Button>

      <Button
        variant="ghost"
        className="flex-1"
        disabled={isSigningOut}
        onClick={handleSignOut}
      >
        <LogOut />
        {isSigningOut ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
