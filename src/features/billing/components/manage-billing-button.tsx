"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { openBillingPortalAction } from "@/actions/billing.action";
import { Button } from "@/components/ui/button";

/** Opens Paddle's customer portal: card, plan change, invoices, cancel. */
export function ManageBillingButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await openBillingPortalAction();
          if (!result.ok) {
            toast.error("Could not open billing", { description: result.error.message });
            return;
          }
          window.location.assign(result.data.url);
        })
      }
    >
      {isPending ? <Loader2 className="animate-spin" /> : <ExternalLink />}
      Manage billing
    </Button>
  );
}
