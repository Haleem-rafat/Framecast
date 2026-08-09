"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { upsertCredentialAction } from "@/actions/provider.action";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";
import {
  aiProviderTypes,
  upsertCredentialSchema,
  type UpsertCredentialInput,
} from "@/schemas/provider.schema";

interface CredentialDialogProps {
  // Deliberately narrower than the full `AiProviderType` enum: this dialog
  // manages vault credentials, and Pexels/Pixabay (env-managed, see
  // env.ts) never reach it — provider-table.tsx only ever passes elements
  // of `aiProviderTypes`, the same set `upsertCredentialSchema` accepts.
  provider: (typeof aiProviderTypes)[number];
  /** Present only when replacing an already-configured key; prefills the label. */
  existingLabel?: string | null;
}

export function CredentialDialog({
  provider,
  existingLabel,
}: CredentialDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isReplace = existingLabel !== undefined;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UpsertCredentialInput>({
    resolver: zodResolver(upsertCredentialSchema),
    defaultValues: { provider, apiKey: "", label: existingLabel ?? "" },
  });

  async function onSubmit(values: UpsertCredentialInput) {
    const result = await upsertCredentialAction(values);

    if (!result.ok) {
      toast.error("Could not save that key", {
        description: result.error.message,
      });
      return;
    }

    toast.success(
      isReplace
        ? `Replaced the ${PROVIDER_LABELS[provider]} key`
        : `Added a ${PROVIDER_LABELS[provider]} key`,
      { description: `Ends in •••• ${result.data.keyLastFour}` },
    );
    reset({ provider, apiKey: "", label: values.label });
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset({ provider, apiKey: "", label: existingLabel ?? "" });
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={isReplace ? "outline" : "default"} size="sm">
          <KeyRound />
          {isReplace ? "Replace key" : "Add key"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader>
            <DialogTitle>
              {isReplace ? "Replace" : "Add"} {PROVIDER_LABELS[provider]} key
            </DialogTitle>
            <DialogDescription>
              Stored encrypted at rest. Framecast only ever displays the last
              four characters back to you.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="apiKey">API key</Label>
              <Input
                id="apiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                aria-invalid={Boolean(errors.apiKey)}
                {...register("apiKey")}
              />
              {errors.apiKey && (
                <p className="text-destructive text-xs">
                  {errors.apiKey.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="label">Label (optional)</Label>
              <Input
                id="label"
                placeholder="e.g. Production key"
                aria-invalid={Boolean(errors.label)}
                {...register("label")}
              />
              {errors.label && (
                <p className="text-destructive text-xs">
                  {errors.label.message}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              {isReplace ? "Replace key" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
