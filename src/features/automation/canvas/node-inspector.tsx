"use client";

import { ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { setAutoPublishAction } from "@/actions/canvas.action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { AUTOMATION_KINDS } from "@/features/automation/kinds";
import type { PublishVisibility } from "@/generated/prisma/enums";
import { useIsMobile } from "@/hooks/use-mobile";
import { countOf, describeHealth } from "@/lib/automation-language";
import type { AutomationEntry } from "@/services/automation-list.service";

/**
 * What one selected automation is, and the one thing you can change from here.
 *
 * ## Why only one thing
 *
 * The panel could plausibly edit the cadence, the topic queue, the script style
 * and the channel — every one of them is a column on a row this is already
 * holding. It edits none of them, and that is a decision rather than an
 * unfinished job.
 *
 * Each of those has a form that shows it in context: the cadence beside the
 * time zone and the day-of-week rule, the channel beside the project it must
 * agree with, the script style beside the variables it declares. Reproducing
 * them in a 320px panel would mean either dropping that context — which is how
 * an operator sets a Monday schedule and gets a Sunday one — or rebuilding the
 * forms twice.
 *
 * Auto-publish is the exception because it genuinely has no context. It is one
 * boolean and one enum with no cross-field rule, and it is the setting an
 * operator most wants to flip while looking at the shape of their channels,
 * which is exactly what this panel is for.
 */
function InspectorBody({
  entry,
  onClose,
}: {
  entry: AutomationEntry;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const meta = AUTOMATION_KINDS[entry.kind];
  const health = describeHealth(entry);
  const Icon = meta.icon;

  const save = (enabled: boolean, visibility: PublishVisibility) => {
    startTransition(async () => {
      const response = await setAutoPublishAction({
        kind: entry.kind === "SERIES" ? "SERIES" : "TOPIC_QUEUE",
        id: entry.id,
        enabled,
        visibility,
      });

      if (!response.ok) {
        toast.error("Could not save that", { description: response.error.message });
        return;
      }

      router.refresh();
    });
  };

  return (
    <>
      <div className="flex items-start gap-2">
        <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{entry.name}</p>
          <p className="text-muted-foreground text-xs">{meta.label}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X />
        </Button>
      </div>

      <Badge
        variant={health.tone === "stopped" ? "destructive" : "secondary"}
        className="mt-3 self-start"
      >
        {health.label}
      </Badge>

      {(health.tone === "warning" || health.tone === "stopped") && (
        <p className="text-muted-foreground mt-2 text-xs">{health.detail}</p>
      )}

      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs">Runs</dt>
          <dd>{entry.cadence}</dd>
        </div>
        {entry.channel && (
          <div>
            <dt className="text-muted-foreground text-xs">Publishes to</dt>
            <dd>{entry.channel.title}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground text-xs">Made / published</dt>
          <dd className="tabular-nums">
            {entry.produced} / {entry.published}
          </dd>
        </div>
        {meta.backlogNoun && entry.backlog !== null && (
          <div>
            <dt className="text-muted-foreground text-xs">Waiting</dt>
            <dd className={entry.backlog === 0 ? "text-destructive" : undefined}>
              {countOf(entry.backlog, meta.backlogNoun)}
            </dd>
          </div>
        )}
      </dl>

      {/* Null for a shorts drip, which publishes by definition. */}
      {entry.autoPublish && (
        <div className="mt-4 space-y-3 border-t pt-4">
          <div className="flex items-start justify-between gap-3">
            <Label htmlFor="inspector-auto-publish" className="text-sm font-medium">
              Publish automatically
            </Label>
            <Switch
              id="inspector-auto-publish"
              checked={entry.autoPublish.enabled}
              disabled={isPending}
              onCheckedChange={(checked) =>
                save(checked, entry.autoPublish!.visibility)
              }
            />
          </div>

          {entry.autoPublish.enabled && (
            <div className="space-y-1.5">
              <Label htmlFor="inspector-visibility" className="text-muted-foreground text-xs">
                Publish as
              </Label>
              <Select
                value={entry.autoPublish.visibility}
                disabled={isPending}
                onValueChange={(value) =>
                  save(true, value as PublishVisibility)
                }
              >
                <SelectTrigger id="inspector-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PRIVATE">Private</SelectItem>
                  <SelectItem value="UNLISTED">Unlisted</SelectItem>
                  <SelectItem value="PUBLIC">Public</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Pause, resume, make one now, delete — whichever this kind has.
          Rendered from the registry rather than rebuilt, so the canvas offers
          exactly what the table's row does and a fourth kind's controls arrive
          here by existing. Each carries its own confirmation where it needs
          one; nothing about being on a canvas makes deleting a show safer. */}
      <div className="mt-4 border-t pt-4">
        <meta.Controls entry={entry} />
      </div>

      <Button asChild variant="outline" className="mt-3">
        <Link href={entry.href}>
          Open {meta.label.toLowerCase()}
          <ArrowUpRight />
        </Link>
      </Button>
    </>
  );
}

/**
 * A right-hand panel on a desktop, a bottom sheet on a phone.
 *
 * The same swap `ResponsiveDialog` makes, for a related reason: a 320px panel
 * pinned to the right edge of a 390px screen is the screen. A sheet leaves the
 * canvas visible above it, which matters here more than in a form — the point
 * of tapping a node is to see it *in* its branch.
 */
export function NodeInspector({
  entry,
  onClose,
}: {
  entry: AutomationEntry;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open onOpenChange={(open) => !open && onClose()}>
        <DrawerContent className="max-h-[85vh]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{entry.name}</DrawerTitle>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-6">
            <InspectorBody entry={entry} onClose={onClose} />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <aside className="bg-card absolute top-0 right-0 z-10 flex h-full w-80 flex-col overflow-y-auto border-l p-4 shadow-lg">
      <InspectorBody entry={entry} onClose={onClose} />
    </aside>
  );
}
