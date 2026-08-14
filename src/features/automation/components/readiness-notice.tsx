import Link from "next/link";
import { ArrowRight, TriangleAlert } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AutomationBlocker } from "@/services/automation.service";

/**
 * What the flow shows instead of the form when the account cannot finish a
 * run.
 *
 * This replaces the wizard rather than sitting above it, and that is the whole
 * point: the first question the flow asks is a topic, and the click after it
 * bills an Anthropic request. Letting an operator answer everything and only
 * then discover their narration key is missing would mean charging them for a
 * script attached to a video that can never finish. Every blocker here is a
 * thing that fails *after* the money is spent, so all of them have to be said
 * before the first question.
 *
 * A server component: it has no state, and rendering it on the server means an
 * account that isn't set up never downloads the wizard's JavaScript at all.
 */
export function ReadinessNotice({ blockers }: { blockers: AutomationBlocker[] }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TriangleAlert className="text-muted-foreground size-4" />
          <CardTitle>
            {blockers.length === 1
              ? "One thing is missing before this can run"
              : `${blockers.length} things are missing before this can run`}
          </CardTitle>
        </div>
        <CardDescription>
          Generating a script costs money on your own API keys, and every stage
          after it costs more. Rather than take your topic and fail partway
          through a paid run, the flow stops here.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <ul className="divide-border divide-y">
          {blockers.map((blocker) => (
            <li key={blocker.id}>
              <Link
                href={blocker.href}
                className="hover:bg-accent/50 -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-medium">{blocker.title}</p>
                  <p className="text-muted-foreground text-xs">{blocker.description}</p>
                </div>
                <ArrowRight className="text-muted-foreground size-4 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
