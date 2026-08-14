"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";
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
import {
  approveAccountAction,
  rejectAccountAction,
} from "@/actions/auth.action";

export function ApprovalDecisionButtons({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function decide(
    action: typeof approveAccountAction,
    successMessage: string,
    failureMessage: string,
  ) {
    startTransition(async () => {
      const result = await action(userId);

      if (!result.ok) {
        // The likely failure is CONFLICT: another operator decided this
        // account between this page rendering and the click. Refreshing is
        // part of the recovery, not just the happy path.
        toast.error(failureMessage, { description: result.error.message });
        router.refresh();
        return;
      }

      toast.success(successMessage);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : <X />}
            Reject
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject {email}?</AlertDialogTitle>
            <AlertDialogDescription>
              The account stays on file but can never open the studio. They will
              see a message saying they were not approved. You can undo this
              only by changing the account directly in the database.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={() =>
                decide(
                  rejectAccountAction,
                  `Rejected ${email}`,
                  "Could not reject that account",
                )
              }
            >
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Button
        size="sm"
        disabled={isPending}
        onClick={() =>
          decide(
            approveAccountAction,
            `Approved ${email}`,
            "Could not approve that account",
          )
        }
      >
        {isPending ? <Loader2 className="animate-spin" /> : <Check />}
        Approve
      </Button>
    </div>
  );
}
