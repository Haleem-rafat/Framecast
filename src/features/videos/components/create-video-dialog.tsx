"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { createVideoAction } from "@/actions/video.action";
import { createVideoSchema, type CreateVideoInput } from "@/schemas/video.schema";

export function CreateVideoDialog({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateVideoInput>({
    resolver: zodResolver(createVideoSchema),
    defaultValues: { projectId: projects[0]?.id ?? "", title: "", topic: "" },
  });

  async function onSubmit(values: CreateVideoInput) {
    const result = await createVideoAction(values);

    if (!result.ok) {
      toast.error("Could not create that video", {
        description: result.error.message,
      });
      return;
    }

    toast.success(`Created "${values.title}"`);
    reset({ projectId: values.projectId, title: "", topic: "" });
    setOpen(false);
    router.push(`/videos/${result.data.id}`);
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <ResponsiveDialogTrigger asChild>
        <Button size="sm" disabled={projects.length === 0}>
          <Plus />
          New video
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>New video</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Starts as a draft. Nothing is generated until you ask for a
              script on the video page.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody>
            {/* Controller wraps the field rather than sitting inside it, so
                RHF's `field` and the field's own `control` props never have to
                share a scope. */}
            <Controller
              control={control}
              name="projectId"
              render={({ field }) => (
                <FormField
                  name="projectId"
                  label="Project"
                  error={errors.projectId?.message}
                >
                  {(controlProps) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger {...controlProps} className="w-full">
                        <SelectValue placeholder="Select a project" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}
            />

            <FormField name="title" label="Title" error={errors.title?.message}>
              {(controlProps) => (
                <Input {...register("title")} {...controlProps} />
              )}
            </FormField>

            <FormField name="topic" label="Topic" error={errors.topic?.message}>
              {(controlProps) => (
                <Textarea
                  rows={3}
                  placeholder="What is this video about? This becomes {{topic}} in the script prompt."
                  {...register("topic")}
                  {...controlProps}
                />
              )}
            </FormField>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Create video
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
