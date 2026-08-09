"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={projects.length === 0}>
          <Plus />
          New video
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>New video</DialogTitle>
            <DialogDescription>
              Starts as a draft. Nothing is generated until you ask for a
              script on the video page.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="projectId">Project</Label>
            <Controller
              control={control}
              name="projectId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="projectId" className="w-full">
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
            />
            {errors.projectId && (
              <p className="text-destructive text-xs">
                {errors.projectId.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              aria-invalid={Boolean(errors.title)}
              {...register("title")}
            />
            {errors.title && (
              <p className="text-destructive text-xs">{errors.title.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="topic">Topic</Label>
            <Textarea
              id="topic"
              rows={3}
              placeholder="What is this video about? This becomes {{topic}} in the script prompt."
              aria-invalid={Boolean(errors.topic)}
              {...register("topic")}
            />
            {errors.topic && (
              <p className="text-destructive text-xs">{errors.topic.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Create video
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
