"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Loader2, Plus, TriangleAlert } from "lucide-react";
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
  /**
   * How many live series file their episodes here.
   *
   * The reason this dialog needs it: a series keeps its own copy of the channel,
   * and every series screen shows that copy, while an upload uses the project's.
   * Changing the channel here used to move the second and leave the first
   * saying something else — a show captioned "kids channel" everywhere, one
   * click from uploading to a finance channel, with nothing on screen to
   * suggest it. `projectService.update` now refuses that edit outright unless
   * the request acknowledges it, and this number is what the acknowledgement is
   * made of: the operator is told how many shows move before they can confirm
   * that they do.
   */
  seriesCount: number;
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
    // Never carried over from a previous open. Consent to move somebody's shows
    // onto a different channel is consent to *this* edit and no other, and a
    // dialog that remembered the tick would be a dialog where the second edit
    // is quieter than the first.
    moveAttachedSeries: false,
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

  const moveSeriesId = useId();

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: toDefaultValues(project),
  });

  const selectedChannelId = watch("channelId") ?? null;
  const moveAttachedSeries = watch("moveAttachedSeries") ?? false;

  /**
   * Whether this save would move shows onto a different channel.
   *
   * Computed from the picker's live value rather than checked on submit,
   * because the point is to say so *before* the button is pressed — the whole
   * defect being closed here is one where nothing was said until an upload had
   * already landed on the wrong channel.
   */
  const seriesCount = project?.seriesCount ?? 0;
  const movesSeries =
    isEdit && seriesCount > 0 && selectedChannelId !== (project?.channelId ?? null);
  const clearsChannel = movesSeries && selectedChannelId === null;
  const destinationTitle =
    channels.find((channel) => channel.id === selectedChannelId)?.title ?? null;
  const shows = `${seriesCount} series`;

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
            {/* Only when the edit would actually do it. A project with no
              * series, or one whose channel is not being touched, gets nothing
              * — this is a warning about a specific consequence, and a standing
              * notice about a consequence that is not happening is how people
              * learn to click past warnings. */}
            {movesSeries && (
              <div className="border-destructive/30 bg-destructive/10 space-y-2 rounded-lg border p-3">
                <p className="flex items-start gap-2 text-sm">
                  <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
                  <span>
                    {clearsChannel ? (
                      <>
                        {shows} file{seriesCount === 1 ? "s" : ""} episodes here,
                        and a series has to have a channel — it takes its niche,
                        voice, art style and made-for-kids declaration from one.
                        Leaving this project without a channel is refused; point
                        the series elsewhere first.
                      </>
                    ) : (
                      <>
                        {shows} file{seriesCount === 1 ? "s" : ""} episodes here.
                        Saving this moves {seriesCount === 1 ? "it" : "them"} to{" "}
                        <strong>{destinationTitle ?? "the chosen channel"}</strong>{" "}
                        as well, and every unpublished episode already filed here
                        goes with {seriesCount === 1 ? "it" : "them"}. Publishing
                        to YouTube can&apos;t be undone.
                      </>
                    )}
                  </span>
                </p>

                {!clearsChannel && (
                  <Controller
                    control={control}
                    name="moveAttachedSeries"
                    render={({ field }) => (
                      <div className="flex items-start justify-between gap-3">
                        <Label
                          htmlFor={moveSeriesId}
                          className="font-normal text-sm"
                        >
                          Yes, move {seriesCount === 1 ? "that series" : "those series"}{" "}
                          too
                        </Label>
                        <Switch
                          id={moveSeriesId}
                          checked={field.value ?? false}
                          onCheckedChange={field.onChange}
                          className="mt-0.5"
                        />
                      </div>
                    )}
                  />
                )}
              </div>
            )}
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            {/* Blocked until the move is acknowledged rather than allowed and
              * refused by the server. The server refuses it too — that is the
              * guard that actually holds, and it holds for every caller — but
              * an operator should not have to submit an irreversible-sounding
              * edit to find out it needs a tick. */}
            <Button
              type="submit"
              disabled={isSubmitting || (movesSeries && !moveAttachedSeries)}
            >
              {isSubmitting && <Loader2 className="animate-spin" />}
              {isEdit ? "Save project" : "Create project"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
