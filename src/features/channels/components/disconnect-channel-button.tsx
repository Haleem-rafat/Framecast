"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2, Unlink } from "lucide-react";
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
import { disconnectChannelAction } from "@/actions/channel.action";

export function DisconnectChannelButton({
  channelId,
  channelTitle,
}: {
  channelId: string;
  channelTitle: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      const result = await disconnectChannelAction(channelId);

      if (result.error) {
        toast.error("Could not disconnect channel", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Disconnected ${channelTitle}`);
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <Unlink />}
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {channelTitle}?</AlertDialogTitle>
          <AlertDialogDescription>
            Framecast will delete its stored upload credentials for this
            channel. Any scheduled publications tied to it are removed too.
            You can reconnect at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
