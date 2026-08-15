"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/shared/responsive-dialog";
import { PROMPT_CATEGORY_LABELS } from "@/features/prompts/prompt-category-labels";
import { SCRIPT_STYLES } from "@/lib/script-styles";
import { addScriptStyleAction } from "@/actions/prompt.action";

/**
 * The built-in styles, and one button to copy one into the operator's own
 * library.
 *
 * A dialog rather than a seventh tab: the tab strip on this page is keyed by
 * `PromptCategory` and already scrolls sideways on a phone, and a browse
 * surface is not a category. It opens from the page header, next to the
 * library it adds to.
 *
 * Nothing here is a marketplace. There are no counts, no ratings and no
 * ranking — the order is the order the catalogue declares, and every number on
 * screen (the target length, the variable keys) is a property of the prompt
 * itself rather than a claim about anybody using it.
 */
export function ScriptStyleBrowser({
  ownedStyleIds,
}: {
  /**
   * Which catalogue styles are already in the library, resolved server-side by
   * `listOwnedScriptStyleIds`. Matched on name, so an operator who renamed
   * their copy is offered the style again — correctly, because the add will
   * succeed.
   */
  ownedStyleIds: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  /** Which row's button is spinning. `isPending` alone would spin all five. */
  const [addingId, setAddingId] = useState<string | null>(null);
  const owned = new Set(ownedStyleIds);

  function onAdd(styleId: string, styleName: string) {
    setAddingId(styleId);

    startTransition(async () => {
      const result = await addScriptStyleAction(styleId);
      setAddingId(null);

      if (!result.ok) {
        toast.error(`Could not add "${styleName}"`, {
          description: result.error.message,
        });
        return;
      }

      toast.success(
        result.data.restored
          ? `"${result.data.name}" is back in your library`
          : `Added "${result.data.name}" to your library`,
        {
          description: result.data.becameDefault
            ? "It is your copy now — edit it freely. It is also your default script prompt, because you had none."
            : "It is your copy now — edit it freely. Pick it per video in the script panel.",
        },
      );

      // Closes, because the point of adding is to go and edit it: the library
      // behind this dialog is where the new card appears, and leaving the
      // browser open would hide it behind the thing that created it.
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Sparkles />
          Browse styles
        </Button>
      </ResponsiveDialogTrigger>

      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Browse styles</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Ready-made prompts that ship with Framecast. Adding one puts a copy
            in your library — yours to edit, with no link back to this list.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <ul className="space-y-3">
            {SCRIPT_STYLES.map((style) => {
              const alreadyOwned = owned.has(style.id);

              return (
                <li key={style.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">{style.name}</h3>
                        <Badge variant="outline">
                          {PROMPT_CATEGORY_LABELS[style.category]}
                        </Badge>
                        <Badge variant="outline">{style.targetLength}</Badge>
                      </div>
                      <p className="text-muted-foreground text-sm text-pretty">
                        {style.description}
                      </p>
                    </div>

                    {/* Already-added styles keep a control-shaped slot rather
                      * than losing one, so the rows stay aligned and the
                      * state is legible without reading the library first. */}
                    {alreadyOwned ? (
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                        <Check className="size-3.5" />
                        In your library
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        className="shrink-0"
                        onClick={() => onAdd(style.id, style.name)}
                        disabled={isPending}
                      >
                        {addingId === style.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Plus />
                        )}
                        Add to library
                      </Button>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {style.variables.map((variable) => (
                      <Badge
                        key={variable.key}
                        variant="outline"
                        className="font-mono"
                      >
                        {variable.key}
                        {variable.required && "*"}
                      </Badge>
                    ))}
                  </div>

                  {/* The whole prompt, behind a disclosure. An operator is
                    * about to make this the instruction behind every script
                    * from a channel — "trust the one-line description" is not
                    * a reasonable thing to ask, and `<details>` costs nothing
                    * until it is opened. */}
                  <details className="group">
                    <summary className="text-muted-foreground cursor-pointer text-xs underline underline-offset-3">
                      Read the prompt
                    </summary>
                    <pre className="bg-muted/50 mt-2 max-h-72 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
                      {style.content}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
