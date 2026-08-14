"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/shared/responsive-dialog";
import { FormField } from "@/components/shared/form-field";
import { Input } from "@/components/ui/input";
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
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset({ provider, apiKey: "", label: existingLabel ?? "" });
        }
      }}
    >
      <ResponsiveDialogTrigger asChild>
        <Button variant={isReplace ? "outline" : "default"} size="sm">
          <KeyRound />
          {isReplace ? "Replace key" : "Add key"}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {isReplace ? "Replace" : "Add"} {PROVIDER_LABELS[provider]} key
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Stored encrypted at rest. Framecast only ever displays the last
              four characters back to you.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          {/* No spacing wrapper of its own: the body already gaps its
              children, and the extra `space-y-4 py-2` that used to sit here was
              a second helping of padding on top of the primitive's. */}
          <ResponsiveDialogBody>
            <FormField
              name="apiKey"
              label="API key"
              error={errors.apiKey?.message}
            >
              {(control) => (
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-..."
                  {...register("apiKey")}
                  {...control}
                />
              )}
            </FormField>

            <FormField
              name="label"
              label="Label (optional)"
              error={errors.label?.message}
            >
              {(control) => (
                <Input
                  placeholder="e.g. Production key"
                  {...register("label")}
                  {...control}
                />
              )}
            </FormField>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              {isReplace ? "Replace key" : "Save key"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
