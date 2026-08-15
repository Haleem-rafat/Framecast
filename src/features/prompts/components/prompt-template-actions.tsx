"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2, Pencil, Star, Trash2 } from "lucide-react";
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
  removePromptAction,
  updatePromptAction,
} from "@/actions/prompt.action";
import { PromptTemplateDialog } from "@/features/prompts/components/prompt-template-dialog";
import type { PromptTemplateWithVariables } from "@/features/prompts/types";

/**
 * Edit, Set default and Delete for one template — lifted out of the card this
 * page used to be built from, unchanged, so the row and the bulk bar are
 * demonstrably acting through the same two actions.
 */
export function PromptTemplateActions({
  template,
}: {
  template: PromptTemplateWithVariables;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onSetDefault() {
    startTransition(async () => {
      const result = await updatePromptAction(template.id, {
        name: template.name,
        description: template.description ?? undefined,
        category: template.category,
        content: template.content,
        isDefault: true,
        variables: template.variables.map((one) => ({
          key: one.key,
          label: one.label,
          defaultValue: one.defaultValue ?? undefined,
          required: one.required,
        })),
      });

      if (!result.ok) {
        toast.error("Could not set as default", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`"${template.name}" is now the default`);
      router.refresh();
    });
  }

  function onDelete() {
    startTransition(async () => {
      const result = await removePromptAction(template.id);

      if (!result.ok) {
        toast.error("Could not delete that template", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Deleted "${template.name}"`);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <PromptTemplateDialog
        category={template.category}
        template={template}
        trigger={
          <Button variant="ghost" size="sm">
            <Pencil />
            Edit
          </Button>
        }
      />

      {!template.isDefault && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onSetDefault}
          disabled={isPending}
        >
          {isPending ? <Loader2 className="animate-spin" /> : <Star />}
          Set default
        </Button>
      )}

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={isPending}>
            <Trash2 />
            Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {template.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This template will no longer be available when generating
              content. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
