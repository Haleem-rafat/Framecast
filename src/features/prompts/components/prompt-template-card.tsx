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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  removePromptAction,
  updatePromptAction,
} from "@/actions/prompt.action";
import { PromptTemplateDialog } from "@/features/prompts/components/prompt-template-dialog";
import type { PromptTemplateWithVariables } from "@/features/prompts/types";

export function PromptTemplateCard({
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
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {/* The template name is the card's title; as a `<p>` it was
              * absent from the heading outline of a page that is nothing but
              * a grid of these. */}
            <h3 className="truncate font-medium">{template.name}</h3>
            {template.isDefault && <Badge>Default</Badge>}
          </div>
          {template.description && (
            <p className="text-muted-foreground text-sm">
              {template.description}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {template.variables.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {template.variables.map((variable) => (
              <Badge key={variable.id} variant="outline" className="font-mono">
                {variable.key}
                {variable.required && "*"}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">No variables</p>
        )}

        <div className="flex items-center gap-2">
          <PromptTemplateDialog
            category={template.category}
            template={template}
            trigger={
              <Button variant="outline" size="sm">
                <Pencil />
                Edit
              </Button>
            }
          />

          {!template.isDefault && (
            <Button
              variant="outline"
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
      </CardContent>
    </Card>
  );
}
