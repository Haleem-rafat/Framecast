"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { ExternalLink, Loader2, Settings2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { FOOTAGE_STYLES } from "@/lib/footage-styles";
import {
  MADE_FOR_KIDS_CONSEQUENCES,
  MADE_FOR_KIDS_GUIDANCE_URL,
  MADE_FOR_KIDS_QUESTION,
  MADE_FOR_KIDS_TEST,
} from "@/lib/youtube-audience";
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
 * The three fields every upload from this channel carries, and the only place
 * they are edited.
 *
 * Per channel rather than per video on purpose: a channel's videos are
 * written, narrated and categorised the same way every time, so asking on
 * every publish would be asking the same question repeatedly and would let one
 * wrong answer split a channel's catalogue across two categories. The publish
 * dialog stays about the one decision that genuinely is per video — who can
 * watch it.
 *
 * The audience declaration is here for a stronger version of the same reason.
 * A channel has one audience; YouTube asks the question at the channel level
 * in Studio too; and it is a COPPA declaration, so putting a toggle for it
 * inside the dialog whose button cannot be un-clicked would be putting a legal
 * statement one stray click from being false. The publish dialog *states* what
 * is about to be sent (see `PublishVideoButton`) and cannot change it.
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
  // Generated rather than written out: this dialog is rendered once per
  // channel card, so a literal id would be duplicated across the page and the
  // label would point at whichever switch happened to mount first.
  const audienceId = useId();
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
              What every upload from {channelTitle} tells YouTube about itself
              — the language and category that decide who it is shown to, and
              the audience declaration that decides what YouTube allows on it.
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

            {/* The audience declaration, and the reason it is a bordered block
              * rather than a third field in the stack: it is not a preference
              * like the two above it. It is a legal statement under COPPA, the
              * question has a specific test behind it, and turning it on
              * changes what YouTube permits on every video this channel has.
              * None of that fits on one line of helper text, and an operator
              * who cannot answer it correctly is the failure mode this whole
              * setting exists to prevent. */}
            <Controller
              control={control}
              name="madeForKids"
              render={({ field }) => (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <label
                      htmlFor={audienceId}
                      className="flex flex-col items-start gap-1 text-sm"
                    >
                      <span className="font-medium">
                        {MADE_FOR_KIDS_QUESTION}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {MADE_FOR_KIDS_TEST}
                      </span>
                    </label>
                    <Switch
                      id={audienceId}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      className="mt-0.5"
                    />
                  </div>

                  {/* Stated whichever way the switch is set, because both
                    * answers have consequences and only one of them is
                    * visible as a change. An operator turning it *on* should
                    * see what it costs before saving; an operator leaving it
                    * off should see that "off" is itself a declaration. */}
                  {field.value ? (
                    <div className="text-muted-foreground space-y-1 text-xs">
                      <p className="text-foreground font-medium">
                        Every upload from this channel — videos and shorts —
                        will be declared made for kids. On each one:
                      </p>
                      <ul className="list-disc space-y-0.5 pl-4">
                        {MADE_FOR_KIDS_CONSEQUENCES.map((consequence) => (
                          <li key={consequence}>{consequence}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Every upload from this channel — videos and shorts — will
                      be declared <strong>not</strong> made for kids, keeping
                      comments, notifications and personalised ads. Declaring
                      this wrongly is not a YouTube technicality: the US FTC
                      has taken action against creators under COPPA over
                      child-directed content declared otherwise.
                    </p>
                  )}

                  <a
                    href={MADE_FOR_KIDS_GUIDANCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground inline-flex items-center gap-1 text-xs underline underline-offset-3"
                  >
                    YouTube&apos;s guidance on this question
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            />

            {/* Last, and after the audience block on purpose: it is the one
              * field here YouTube never sees, and it is the one an operator
              * most often wants to change right after answering the question
              * above. A channel directed to children almost always wants
              * cartoons; keeping the two questions on the same screen is what
              * stops a kids channel being declared for kids and then
              * illustrated with live-action stock. */}
            <Controller
              control={control}
              name="footageStyle"
              render={({ field }) => (
                <FormField
                  name="footageStyle"
                  label="Footage"
                  description={
                    FOOTAGE_STYLES.find((option) => option.value === field.value)
                      ?.description
                  }
                  error={errors.footageStyle?.message}
                >
                  {(controlProps) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger {...controlProps} className="w-full">
                        <SelectValue placeholder="Pick a footage style" />
                      </SelectTrigger>
                      <SelectContent>
                        {FOOTAGE_STYLES.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}
            />
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
