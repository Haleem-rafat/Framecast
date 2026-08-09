"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { testCredentialAction } from "@/actions/provider.action";
import type { AiProviderType } from "@/generated/prisma/enums";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";

export function TestCredentialButton({
  provider,
}: {
  provider: AiProviderType;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onTest() {
    startTransition(async () => {
      const result = await testCredentialAction(provider);

      if (!result.ok) {
        toast.error(`Could not test the ${PROVIDER_LABELS[provider]} key`, {
          description: result.error.message,
        });
        return;
      }

      if (result.data.ok) {
        toast.success(`${PROVIDER_LABELS[provider]} key is working`);
      } else {
        toast.error(`${PROVIDER_LABELS[provider]} key was rejected`, {
          description: "The upstream provider did not accept this key.",
        });
      }

      // lastTestedAt / lastTestOk live on the server-rendered row.
      router.refresh();
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onTest} disabled={isPending}>
      {isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
      Test
    </Button>
  );
}
