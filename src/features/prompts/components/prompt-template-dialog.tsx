"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createPromptAction, updatePromptAction } from "@/actions/prompt.action";
import type { PromptCategory } from "@/generated/prisma/enums";
import { PROMPT_CATEGORY_LABELS } from "@/features/prompts/prompt-category-labels";
import type { PromptTemplateWithVariables } from "@/features/prompts/types";
import { extractVariables } from "@/lib/prompt-template";
import {
  promptCategories,
  upsertPromptSchema,
  type UpsertPromptInput,
} from "@/schemas/prompt.schema";

/**
 * `isDefault` and `variables[].required` carry `.default()` in the schema, so
 * the zod *input* type (what the form actually holds pre-submit) has them
 * optional while the *output* type (what `onSubmit` receives) has them
 * required. RHF's 3-generic `useForm` lets the resolver bridge the two.
 */
type PromptFormValues = z.input<typeof upsertPromptSchema>;

interface PromptTemplateDialogProps {
  trigger: ReactNode;
  category: PromptCategory;
  /** Present in edit mode; absent when creating a new template for `category`. */
  template?: PromptTemplateWithVariables;
}

function toDefaultValues(
  category: PromptCategory,
  template?: PromptTemplateWithVariables,
): UpsertPromptInput {
  if (!template) {
    return {
      name: "",
      description: "",
      category,
      content: "",
      isDefault: false,
      variables: [],
    };
  }

  return {
    name: template.name,
    description: template.description ?? "",
    category: template.category,
    content: template.content,
    isDefault: template.isDefault,
    variables: template.variables.map((one) => ({
      key: one.key,
      label: one.label,
      defaultValue: one.defaultValue ?? "",
      required: one.required,
    })),
  };
}

export function PromptTemplateDialog({
  trigger,
  category,
  template,
}: PromptTemplateDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(template);

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PromptFormValues, unknown, UpsertPromptInput>({
    resolver: zodResolver(upsertPromptSchema),
    defaultValues: toDefaultValues(category, template),
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "variables",
  });

  const content = watch("content");

  async function onSubmit(values: UpsertPromptInput) {
    // A placeholder with no declared row renders literally rather than being
    // filled — the operator needs to know before they walk away from this dialog.
    const placeholders = extractVariables(values.content);
    const declaredKeys = new Set(values.variables.map((one) => one.key));
    const undeclared = placeholders.filter((key) => !declaredKeys.has(key));

    if (undeclared.length > 0) {
      toast.warning("Content references undeclared variables", {
        description: `{{${undeclared.join("}}, {{")}}} has no matching row in the variable table.`,
      });
    }

    const result = isEdit
      ? await updatePromptAction(template!.id, values)
      : await createPromptAction(values);

    if (!result.ok) {
      toast.error("Could not save that template", {
        description: result.error.message,
      });
      return;
    }

    toast.success(isEdit ? "Template updated" : "Template created");
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset(toDefaultValues(category, template));
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit template" : "New template"}</DialogTitle>
            <DialogDescription>
              Prompts use <code>{"{{variable}}"}</code> placeholders resolved
              from the table below when a script, thumbnail, or scene is
              generated.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                aria-invalid={Boolean(errors.name)}
                {...register("name")}
              />
              {errors.name && (
                <p className="text-destructive text-xs">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Controller
                control={control}
                name="category"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="category" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {promptCategories.map((one) => (
                        <SelectItem key={one} value={one}>
                          {PROMPT_CATEGORY_LABELS[one]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Input id="description" {...register("description")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="content">Prompt content</Label>
            <Textarea
              id="content"
              rows={8}
              className="min-h-40 font-mono text-sm"
              aria-invalid={Boolean(errors.content)}
              {...register("content")}
            />
            {errors.content && (
              <p className="text-destructive text-xs">
                {errors.content.message}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              {extractVariables(content ?? "").length} placeholder(s) detected
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Variables</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  append({ key: "", label: "", defaultValue: "", required: false })
                }
              >
                <Plus />
                Add variable
              </Button>
            </div>

            {fields.length > 0 && (
              <div className="space-y-2 rounded-lg border p-2">
                <div className="text-muted-foreground grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-2 px-1 text-xs">
                  <span>Key</span>
                  <span>Label</span>
                  <span>Default</span>
                  <span>Required</span>
                  <span />
                </div>
                {fields.map((field, index) => (
                  <div
                    key={field.id}
                    className="grid grid-cols-[1fr_1fr_1fr_auto_auto] items-center gap-2"
                  >
                    <Input
                      placeholder="topic"
                      aria-invalid={Boolean(errors.variables?.[index]?.key)}
                      {...register(`variables.${index}.key` as const)}
                    />
                    <Input
                      placeholder="Topic"
                      {...register(`variables.${index}.label` as const)}
                    />
                    <Input
                      placeholder="(none)"
                      {...register(`variables.${index}.defaultValue` as const)}
                    />
                    <Controller
                      control={control}
                      name={`variables.${index}.required` as const}
                      render={({ field: requiredField }) => (
                        <Switch
                          checked={requiredField.value}
                          onCheckedChange={requiredField.onChange}
                        />
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(index)}
                    >
                      <Trash2 />
                      <span className="sr-only">Remove variable</span>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Controller
              control={control}
              name="isDefault"
              render={({ field }) => (
                <Switch
                  id="isDefault"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <Label htmlFor="isDefault" className="font-normal">
              Make this the default template for its category
            </Label>
          </div>
          </DialogBody>


          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Save template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
