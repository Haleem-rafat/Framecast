"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Loader2, Plus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createProjectAction,
  updateProjectAction,
} from "@/actions/project.action";
import { createProjectSchema, type CreateProjectInput } from "@/schemas/project.schema";

/**
 * Radix's `Select` reserves the empty string for "nothing chosen", so the
 * "this project publishes nowhere in particular" entry needs a value of its
 * own — the same sentinel trick `DataTable`'s mobile sort picker uses.
 */
const NONE_CHANNEL = "__none__";

export interface ProjectDialogProject {
  id: string;
  name: string;
  description: string | null;
  channelId: string | null;
}

interface ProjectDialogProps {
  channels: { id: string; title: string }[];
  /** Present in edit mode; absent when creating. */
  project?: ProjectDialogProject;
  /** Defaults to the "New project" button, which is all the create sites want. */
  trigger?: ReactNode;
}

function toDefaultValues(project?: ProjectDialogProject): CreateProjectInput {
  return {
    name: project?.name ?? "",
    description: project?.description ?? "",
    // `undefined`, not `null`: the schema's `channelId` is optional, and the
    // service reads `?? null`, so an absent value is what clears the channel.
    channelId: project?.channelId ?? undefined,
  };
}

/**
 * Create or edit one project, over `createProjectSchema` in both directions —
 * `projectService.update` takes the very same input type, so there is nothing
 * for a second form to describe.
 *
 * Editing exists because until now it did not: a project created before a
 * channel was connected had no way to be given one, and its videos published
 * nowhere with no explanation on the project page. `updateProjectAction` has
 * been in the tree, validated, the whole time; this is its first caller.
 */
export function ProjectDialog({ channels, project, trigger }: ProjectDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(project);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: toDefaultValues(project),
  });

  async function onSubmit(values: CreateProjectInput) {
    const result = isEdit
      ? await updateProjectAction(project!.id, values)
      : await createProjectAction(values);

    if (!result.ok) {
      toast.error(
        isEdit ? "Could not save that project" : "Could not create that project",
        { description: result.error.message },
      );
      return;
    }

    toast.success(isEdit ? `Saved "${values.name}"` : `Created "${values.name}"`);
    // A create empties the form for the next one; an edit keeps the values it
    // just saved, so reopening the dialog shows what is actually stored.
    reset(isEdit ? values : toDefaultValues());
    setOpen(false);
    router.refresh();
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reopening after a cancel must show the stored values again, not the
        // half-typed ones that were abandoned.
        if (!next) reset(toDefaultValues(project));
      }}
    >
      <ResponsiveDialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus />
            New project
          </Button>
        )}
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {isEdit ? "Edit project" : "New project"}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Projects group videos and can carry a default publishing
              channel.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody>
            <FormField name="name" label="Name" error={errors.name?.message}>
              {(controlProps) => <Input {...register("name")} {...controlProps} />}
            </FormField>

            {/* `description` and `channelId` render their errors. Both could
                previously fail the resolver with nothing on screen: the submit
                simply did not happen and the dialog gave no reason. */}
            <FormField
              name="description"
              label="Description (optional)"
              error={errors.description?.message}
            >
              {(controlProps) => (
                <Textarea rows={3} {...register("description")} {...controlProps} />
              )}
            </FormField>

            {channels.length > 0 && (
              <Controller
                control={control}
                name="channelId"
                render={({ field }) => (
                  <FormField
                    name="channelId"
                    label="Default channel (optional)"
                    description={
                      isEdit
                        ? "Videos in this project publish here unless one overrides it."
                        : undefined
                    }
                    error={errors.channelId?.message}
                  >
                    {(controlProps) => (
                      <Select
                        value={field.value ?? NONE_CHANNEL}
                        onValueChange={(value) =>
                          field.onChange(value === NONE_CHANNEL ? undefined : value)
                        }
                      >
                        <SelectTrigger {...controlProps} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_CHANNEL}>None</SelectItem>
                          {channels.map((channel) => (
                            <SelectItem key={channel.id} value={channel.id}>
                              {channel.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                )}
              />
            )}
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              {isEdit ? "Save project" : "Create project"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
