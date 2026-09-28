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
import { describeTopicShape } from "@/lib/topic-shape";
import type { ScheduleTopicRecord } from "@/services/schedule.service";

/**
 * The queue, which is where topics come from — and which now fills itself.
 *
 * This card used to promise "it will never invent a subject you did not
 * choose", and that promise is gone. Below three waiting topics the studio
 * generates ten more and appends them (`TopicQueueService`), ranked against this
 * channel's own figures, and the schedule no longer pauses when the list runs
 * out. Saying otherwise on the screen the operator reads while they look at that
 * list would be the worst kind of stale copy: it describes a safeguard they would
 * rely on and that is not there.
 *
 * So the description says what actually happens, and every generated row is
 * labelled. That label is the part that does the work the old promise was
 * really making: the operator can still see exactly what is coming, can still
 * tell their own subjects from the studio's, and can still delete one they do
 * not want with the same click.
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

  /**
   * The first line worth saying something about, or null.
   *
   * One hint rather than one per line: somebody pasting twenty topics at once
   * would otherwise get twenty near-identical paragraphs under the box, which
   * is a wall to scroll past rather than a thing to read. The first is enough
   * to make the point, and the point generalises.
   *
   * Advice only — `describeTopicShape` cannot refuse a topic and the Add button
   * below is deliberately not gated on it. See that module's header for why.
   */
  const hint = parsed.map(describeTopicShape).find((shape) => !shape.ok)?.hint ?? null;

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
          Each run takes the topic at the top. When fewer than three are left,
          Framecast writes ten more and adds them to the end — picked for reach
          against this channel&rsquo;s own view figures, and never repeating a
          subject you have already covered. Generated ones are marked below;
          delete any you would rather not make. The schedule only stops if that
          generation fails.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {waiting.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
            Nothing queued yet. Framecast will write ten topics before the next
            run &mdash; or add your own below and it will make those first.
          </p>
        ) : (
          <ol className="divide-border divide-y text-sm">
            {waiting.map((topic, index) => (
              <li key={topic.id} className="flex items-start gap-3 py-2">
                <span className="text-muted-foreground w-6 shrink-0 pt-0.5 text-xs tabular-nums">
                  {index + 1}
                </span>
                <span className="flex-1">{topic.topic}</span>
                {/* Marked rather than hidden or styled differently. A generated
                    topic is going to become a video on a real channel under the
                    operator's name, so the one thing the list owes them is to be
                    plain about which subjects they did not choose. */}
                {topic.generated && (
                  <Badge
                    variant="secondary"
                    className="shrink-0"
                    title="Written by Framecast because the queue was running low"
                  >
                    Auto
                  </Badge>
                )}
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

          {hint !== null && (
            <p className="text-muted-foreground text-xs text-balance">{hint}</p>
          )}

          <Button type="submit" size="sm" disabled={parsed.length === 0 || isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Add {parsed.length > 0 ? parsed.length : ""}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
