"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Loader2, Settings2, TriangleAlert } from "lucide-react";
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
import {
  listVideoCategoriesAction,
  updatePublishingDefaultsAction,
} from "@/actions/channel.action";
import {
  CURATED_CATEGORIES,
  type PublishingDefaults,
  type VideoCategory,
} from "@/lib/youtube-categories";
import {
  publishingDefaultsFormSchema,
  type PublishingDefaultsFormValues,
} from "@/schemas/channel.schema";

/**
 * The two fields every upload from this channel carries, and the only place
 * they are edited.
 *
 * Per channel rather than per video on purpose: a channel's videos are
 * written, narrated and categorised the same way every time, so asking on
 * every publish would be asking the same question repeatedly and would let one
 * wrong answer split a channel's catalogue across two categories. The publish
 * dialog stays about the one decision that genuinely is per video — who can
 * watch it.
 */
export function PublishingDefaultsDialog({
  channelId,
  channelTitle,
  defaults,
}: {
  channelId: string;
  channelTitle: string;
  defaults: PublishingDefaults;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  /**
   * Starts as the curated list so the select is usable on the very first
   * frame — before the fetch resolves, and if it never does. `live` says which
   * of the two the operator is currently looking at, because "these are the
   * categories YouTube accepts" and "these are the categories YouTube
   * accepted for a US channel when this was written" are not the same claim.
   */
  const [categories, setCategories] = useState<readonly VideoCategory[]>(
    CURATED_CATEGORIES,
  );
  const [live, setLive] = useState<boolean | null>(null);
  const [loadingCategories, setLoadingCategories] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PublishingDefaultsFormValues>({
    resolver: zodResolver(publishingDefaultsFormSchema),
    defaultValues: defaults,
  });

  /**
   * Two YouTube round trips, so they happen when the dialog opens rather than
   * with the page — most visits to /channels are not about categories. The
   * action cannot fail for a reachability reason (`listCategories` degrades to
   * the curated list itself), so a rejected result here means the session
   * check failed and the curated list already on screen is the right thing to
   * leave up.
   */
  async function loadCategories() {
    setLoadingCategories(true);
    const result = await listVideoCategoriesAction(channelId);
    setLoadingCategories(false);

    if (!result.ok) {
      setLive(false);
      return;
    }

    setCategories(result.data.categories);
    setLive(result.data.live);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);

    if (next) {
      void loadCategories();
      return;
    }

    // Closing without saving reverts to what is actually stored, so a
    // half-made edit is never what the next open starts from.
    reset(defaults);
  }

  async function onSubmit(values: PublishingDefaultsFormValues) {
    const result = await updatePublishingDefaultsAction({
      channelId,
      ...values,
    });

    if (!result.ok) {
      toast.error("Could not save these defaults", {
        description: result.error.message,
      });
      return;
    }

    toast.success(`Saved publishing defaults for ${channelTitle}`);
    reset(result.data);
    setOpen(false);
    router.refresh();
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 />
          Publishing defaults
        </Button>
      </ResponsiveDialogTrigger>

      <ResponsiveDialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Publishing defaults</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              What every upload from {channelTitle} tells YouTube about itself.
              Both decide who the video gets shown to.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody>
            <FormField
              name="language"
              label="Language"
              description="A BCP-47 tag — en, en-GB, pt-BR. Sent as both the metadata language and the spoken language, which are the same here: the description is built from the script the voice reads."
              error={errors.language?.message}
            >
              {(controlProps) => (
                <Input
                  placeholder="en"
                  autoComplete="off"
                  {...register("language")}
                  {...controlProps}
                />
              )}
            </FormField>

            <Controller
              control={control}
              name="categoryId"
              render={({ field }) => (
                <FormField
                  name="categoryId"
                  label="Category"
                  description={
                    loadingCategories
                      ? "Loading the categories YouTube accepts for this channel…"
                      : "Only categories YouTube marks as assignable are listed — anything else is rejected after the whole file has uploaded."
                  }
                  error={errors.categoryId?.message}
                >
                  {(controlProps) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger {...controlProps} className="w-full">
                        <SelectValue placeholder="Pick a category" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((category) => (
                          <SelectItem key={category.id} value={category.id}>
                            {category.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}
            />

            {live === false && (
              <p className="text-muted-foreground flex items-start gap-2 text-xs">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                YouTube didn&apos;t answer, so this is a stored list of the
                categories it accepts for US channels. It may not match what
                your channel&apos;s region allows.
              </p>
            )}
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Save defaults
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
