"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { removeCredentialAction } from "@/actions/provider.action";
import type { AiProviderType } from "@/generated/prisma/enums";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";

export function RevokeCredentialButton({
  provider,
}: {
  provider: AiProviderType;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      const result = await removeCredentialAction(provider);

      if (!result.ok) {
        toast.error("Could not revoke that key", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Revoked the ${PROVIDER_LABELS[provider]} key`);
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Revoke the {PROVIDER_LABELS[provider]} key?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Framecast will delete its stored copy of this key. Any generation
            step that depends on {PROVIDER_LABELS[provider]} will fail until a
            new key is added.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            Revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
