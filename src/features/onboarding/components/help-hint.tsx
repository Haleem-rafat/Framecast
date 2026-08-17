"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Lightbulb, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { helpKey } from "@/features/onboarding/dismissal";
import { resolveHelpTopic } from "@/features/onboarding/help-topics";
import { useOnboarding } from "@/features/onboarding/components/onboarding-provider";

/**
 * The note that appears once, at the top of a screen you have not seen before.
 *
 * ## Why it is mounted by the layout and not by each page
 *
 * There are twenty-odd screens and more arriving. Wiring a hint into each page
 * means every future page is one forgotten import away from having no help at
 * all, which is precisely the failure this whole change is fixing — the old
 * tour covered five screens because five screens is what existed when somebody
 * remembered to add them. One mount point in the layout means the coverage
 * question is answered in `help-topics.ts` alone, where a test can read it.
 *
 * ## Why above the page title
 *
 * `main` is a flex column and this is its first child, so the note sits above
 * the `h1`. That reads oddly for a permanent fixture and correctly for this:
 * the first time you open a screen, the sentence explaining what the screen is
 * for should come before the screen. It is gone on the second visit, and the
 * heading is back where it always was.
 *
 * ## Motion
 *
 * None. It is rendered or it is not. An entrance animation on a panel that
 * appears above the page title would push the whole page down while somebody is
 * reading it, and a `prefers-reduced-motion` branch for a thing that should not
 * animate for anybody is a branch worth not having.
 */
export function HelpHint({ isOperator }: { isOperator: boolean }) {
  const pathname = usePathname();
  const { isDismissed, dismiss } = useOnboarding();

  const topic = resolveHelpTopic(pathname, isOperator);

  if (!topic || isDismissed(helpKey(topic.id))) {
    return null;
  }

  return (
    <aside
      // Labelled by its own heading, so a screen-reader user meets it as a
      // named region they can skip rather than as a wall of text in front of
      // the page they asked for.
      aria-labelledby={`help-hint-${topic.id}`}
      className="bg-muted/40 flex items-start gap-3 rounded-xl border border-dashed p-4"
    >
      <Lightbulb
        aria-hidden="true"
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
      />

      <div className="min-w-0 flex-1 space-y-1">
        <h2
          id={`help-hint-${topic.id}`}
          className="text-sm leading-tight font-medium"
        >
          {topic.title}
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          {topic.body}
        </p>

        {topic.action && (
          <Button
            asChild
            variant="link"
            size="sm"
            className="h-auto px-0 py-1 font-normal"
          >
            <Link href={topic.action.href}>
              {topic.action.label}
              <ArrowRight />
            </Link>
          </Button>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground -mt-1 -mr-1 size-7 shrink-0"
        onClick={() => dismiss(helpKey(topic.id))}
        // Names the screen it is closing. A page can only ever show one of
        // these, but the palette offers "bring the notes back" globally, and
        // "Close" on its own tells a screen-reader user nothing about which of
        // twenty notes they just heard.
        aria-label={`Close the note about ${topic.title}`}
      >
        <X />
      </Button>
    </aside>
  );
}
