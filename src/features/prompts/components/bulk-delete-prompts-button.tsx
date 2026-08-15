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
import { removePromptAction } from "@/actions/prompt.action";
import { PROMPT_CATEGORY_LABELS } from "@/features/prompts/prompt-category-labels";
import type { PromptTemplateWithVariables } from "@/features/prompts/types";

/**
 * Delete every selected template.
 *
 * `PromptTemplateService.remove` has no in-use check — nothing in the schema
 * links a generated script back to the template that produced it, so there is
 * no "this one is used by 12 videos" to compute and none is claimed here. It
 * also does not refuse a category default; it soft-deletes the row and clears
 * `isDefault` on the way out. Since the per-row Delete inherits exactly that,
 * so does this one: a bulk action that refused what the single-row action
 * allows would be a second, invisible policy.
 *
 * What it does instead is *say* what that costs. A category left with no
 * default is not an error until the next generation runs, at which point
 * `getDefault` throws a NotFoundError from inside the pipeline — a long way
 * from the click that caused it.
 *
 * A loop of `removePromptAction`, not a bulk service method: `remove` reads
 * through `this.get(userId, id)` first, so each call is scoped to the
 * signed-in operator and a foreign id is a `NotFoundError` rather than a
 * deletion. Six sequential round trips does not justify a new query.
 */
export function BulkDeletePromptsButton({
  templates,
  onDone,
}: {
  templates: PromptTemplateWithVariables[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const defaults = templates.filter((template) => template.isDefault);
  // Every selected template shares a category — each tab renders its own
  // table — so naming the first one names them all.
  const categoryLabel = PROMPT_CATEGORY_LABELS[templates[0]!.category];

  function onConfirm() {
    startTransition(async () => {
      const outcomes = await Promise.all(
        templates.map(async (template) => ({
          template,
          result: await removePromptAction(template.id),
        })),
      );

      const failed = outcomes.filter((one) => !one.result.ok);
      const deleted = outcomes.length - failed.length;

      if (failed.length > 0) {
        const firstError = failed[0]!.result;
        toast.error(`${deleted} deleted, ${failed.length} failed`, {
          description: firstError.ok
            ? undefined
            : `${failed.map((one) => one.template.name).join(", ")} — ${firstError.error.message}`,
        });
      } else if (defaults.length > 0) {
        toast.warning(
          `${deleted} template${deleted === 1 ? "" : "s"} deleted — ${categoryLabel} now has no default`,
          {
            description: `Set another ${categoryLabel.toLowerCase()} template as the default before the next generation runs.`,
          },
        );
      } else {
        toast.success(
          `${deleted} template${deleted === 1 ? "" : "s"} deleted`,
        );
      }

      onDone();
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {templates.length} template
            {templates.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {templates.length === 1 ? "It" : "They"} will no longer be available
            when generating content, and this cannot be undone. Scripts and
            thumbnails already generated from{" "}
            {templates.length === 1 ? "it" : "them"} are unaffected.
            {defaults.length > 0 && (
              <>
                {" "}
                <strong className="font-medium">
                  {defaults.length === 1
                    ? `"${defaults[0]!.name}" is the ${categoryLabel} default.`
                    : `${defaults.length} of these are category defaults.`}
                </strong>{" "}
                Deleting {defaults.length === 1 ? "it" : "them"} leaves{" "}
                {categoryLabel} with no default, and the next generation that
                needs one will fail until you set another.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete {templates.length}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
