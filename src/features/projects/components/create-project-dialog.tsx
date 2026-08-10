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
import { Textarea } from "@/components/ui/textarea";
import { createProjectAction } from "@/actions/project.action";
import { createProjectSchema, type CreateProjectInput } from "@/schemas/project.schema";

const NONE_CHANNEL = "__none__";

export function CreateProjectDialog({
  channels,
}: {
  channels: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: { name: "", description: "", channelId: undefined },
  });

  async function onSubmit(values: CreateProjectInput) {
    const result = await createProjectAction(values);

    if (!result.ok) {
      toast.error("Could not create that project", {
        description: result.error.message,
      });
      return;
    }

    toast.success(`Created "${values.name}"`);
    reset();
    setOpen(false);
    router.refresh();
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
        <Button size="sm">
          <Plus />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Projects group videos and can carry a default publishing
              channel.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>

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
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea id="description" rows={3} {...register("description")} />
          </div>

          {channels.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="channelId">Default channel (optional)</Label>
              <Controller
                control={control}
                name="channelId"
                render={({ field }) => (
                  <Select
                    value={field.value ?? NONE_CHANNEL}
                    onValueChange={(value) =>
                      field.onChange(value === NONE_CHANNEL ? undefined : value)
                    }
                  >
                    <SelectTrigger id="channelId" className="w-full">
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
              />
            </div>
          )}
          </DialogBody>


          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
