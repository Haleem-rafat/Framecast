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
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <ResponsiveDialogTrigger asChild>
        <Button size="sm">
          <Plus />
          New project
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>New project</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Projects group videos and can carry a default publishing
              channel.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody>
            <FormField name="name" label="Name" error={errors.name?.message}>
              {(controlProps) => (
                <Input {...register("name")} {...controlProps} />
              )}
            </FormField>

            {/* `description` and `channelId` render their errors now. Both
                could previously fail the resolver with nothing on screen: the
                submit simply did not happen and the dialog gave no reason. */}
            <FormField
              name="description"
              label="Description (optional)"
              error={errors.description?.message}
            >
              {(controlProps) => (
                <Textarea
                  rows={3}
                  {...register("description")}
                  {...controlProps}
                />
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
                    error={errors.channelId?.message}
                  >
                    {(controlProps) => (
                      <Select
                        value={field.value ?? NONE_CHANNEL}
                        onValueChange={(value) =>
                          field.onChange(
                            value === NONE_CHANNEL ? undefined : value,
                          )
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
              Create project
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
