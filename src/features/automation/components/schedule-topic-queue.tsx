"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

import {
  addScheduleTopicsAction,
  removeScheduleTopicAction,
} from "@/actions/schedule.action";
import { FormField } from "@/components/shared/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { ScheduleTopicRecord } from "@/services/schedule.service";

/**
 * The queue, which is where topics come from.
 *
 * The alternative — a standing instruction the model turns into a fresh subject
 * each week — would mean the studio choosing what a video the operator pays
 * for and puts their name on is *about*. This list is the honest version: the
 * operator writes the subjects in advance, sees exactly which one is next, and
 * when the list runs out the schedule stops rather than improvising.
 *
 * Consumed topics stay visible, greyed, below the waiting ones. They are the
 * only place the queue and the run history meet: an operator scanning the list
 * can see what has already been made without cross-referencing dates.
 */
export function ScheduleTopicQueue({
  scheduleId,
  topics,
}: {
  scheduleId: string;
  topics: ScheduleTopicRecord[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [isPending, startTransition] = useTransition();
  /** Which row's remove button is spinning. Per-row rather than one shared flag
   *  so removing one topic does not visibly disable the whole list. */
  const [removingId, setRemovingId] = useState<string | null>(null);

  const waiting = topics.filter((topic) => topic.consumedAt === null);
  const used = topics.filter((topic) => topic.consumedAt !== null);

  const parsed = draft
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  function onAdd(event: React.FormEvent): void {
    event.preventDefault();

    if (parsed.length === 0 || isPending) {
      return;
    }

    startTransition(async () => {
      const response = await addScheduleTopicsAction(scheduleId, { topics: parsed });

      if (!response.ok) {
        toast.error("Could not add those topics", {
          description: response.error.message,
        });
        return;
      }

      setDraft("");
      toast.success(
        `Added ${response.data.added} topic${response.data.added === 1 ? "" : "s"}`,
      );
      router.refresh();
    });
  }

  function onRemove(topicId: string): void {
    setRemovingId(topicId);

    startTransition(async () => {
      const response = await removeScheduleTopicAction(scheduleId, topicId);
      setRemovingId(null);

      if (!response.ok) {
        toast.error("Could not remove that topic", {
          description: response.error.message,
        });
        return;
      }

      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Topic queue
          <Badge variant={waiting.length === 0 ? "destructive" : "secondary"}>
            {waiting.length} waiting
          </Badge>
        </CardTitle>
        <CardDescription>
          Each run takes the topic at the top. When none are left the schedule
          pauses itself — it will never invent a subject you did not choose.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {waiting.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
            Nothing queued. Add a topic below to give this schedule something to
            make.
          </p>
        ) : (
          <ol className="divide-border divide-y text-sm">
            {waiting.map((topic, index) => (
              <li key={topic.id} className="flex items-start gap-3 py-2">
                <span className="text-muted-foreground w-6 shrink-0 pt-0.5 text-xs tabular-nums">
                  {index + 1}
                </span>
                <span className="flex-1">{topic.topic}</span>
                {index === 0 && (
                  <Badge variant="outline" className="shrink-0">
                    Next
                  </Badge>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={`Remove "${topic.topic}" from the queue`}
                  disabled={isPending}
                  onClick={() => onRemove(topic.id)}
                >
                  {removingId === topic.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <X />
                  )}
                </Button>
              </li>
            ))}
          </ol>
        )}

        {used.length > 0 && (
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer text-xs">
              {used.length} already used
            </summary>
            <ul className="text-muted-foreground mt-2 space-y-1">
              {used.map((topic) => (
                <li key={topic.id} className="line-through">
                  {topic.topic}
                </li>
              ))}
            </ul>
          </details>
        )}

        <form onSubmit={onAdd} className="space-y-2">
          <FormField
            name="topics"
            label="Add topics"
            description="One per line. They join the end of the queue in this order."
          >
            {(control) => (
              <Textarea
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Why some roads are toll roads"
                {...control}
              />
            )}
          </FormField>

          <Button type="submit" size="sm" disabled={parsed.length === 0 || isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Add {parsed.length > 0 ? parsed.length : ""}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
