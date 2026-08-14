"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/shared/responsive-dialog";
import {
  searchSectionFootageAction,
  swapSectionFootageAction,
} from "@/actions/timeline.action";
import type { FootageOption } from "@/services/timeline.service";

/**
 * Picks different stock footage for one section.
 *
 * Two properties of this dialog are load-bearing rather than stylistic.
 *
 * It searches on submit, never as you type. Each search costs one call to
 * Pexels and one to Pixabay, and Pexels allows 200 an hour across this whole
 * installation — including every video's own footage collection. A
 * search-as-you-type box would spend that allowance on prefixes of words.
 *
 * And it sends back the clip's *source and id*, plus the query that produced
 * it — never the clip's URL. The server re-runs that search and matches the
 * id, so the bytes it downloads always come from a URL Pexels or Pixabay just
 * returned. Accepting a URL from here would make the swap endpoint a
 * server-side request forgery primitive aimed wherever the caller liked.
 */
export function TimelineFootageDialog({
  videoId,
  sectionIndex,
  cue,
  open,
  onOpenChange,
}: {
  videoId: string;
  sectionIndex: number;
  /** Seeds the search box: the cue is what this section's current clip was
   *  chosen for, so it is the most useful starting point for finding a better
   *  one — and an operator who wants something else edits it in place. */
  cue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(cue);
  /** The query the results on screen actually came from. The swap has to
   *  re-run that exact string server-side, so it cannot read the input — which
   *  the operator may have kept typing into after searching. */
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const [results, setResults] = useState<FootageOption[]>([]);
  const [isSearching, startSearching] = useTransition();
  const [swappingId, setSwappingId] = useState<string | null>(null);

  function onSearch(event: React.FormEvent) {
    event.preventDefault();
    const submitted = query.trim();

    if (!submitted) {
      return;
    }

    startSearching(async () => {
      const result = await searchSectionFootageAction(videoId, submitted);

      if (!result.ok) {
        // The service's messages already name the real cause — an
        // unconfigured API key, a provider that is down — so they are shown
        // as-is rather than replaced with a generic failure.
        toast.error("Could not search for footage", {
          description: result.error.message,
        });
        return;
      }

      setSearchedQuery(submitted);
      setResults(result.data);
    });
  }

  function onChoose(option: FootageOption) {
    if (!searchedQuery) {
      return;
    }

    setSwappingId(option.externalId);

    void (async () => {
      const result = await swapSectionFootageAction(videoId, {
        sectionIndex,
        source: option.source,
        externalId: option.externalId,
        query: searchedQuery,
      });

      setSwappingId(null);

      if (!result.ok) {
        toast.error("Could not replace this section's footage", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Section ${sectionIndex + 1} now uses this clip`, {
        // Said at the moment of the edit, and again on the card itself. The
        // MP4 on disk is untouched by this — nothing in the app edits a
        // finished render, and an operator who assumed otherwise would publish
        // the old picture.
        description:
          "The rendered video still shows the old clip. It changes when this video renders again.",
      });

      onOpenChange(false);
      // The panel is server-rendered from `timelineService.get`, so a refresh
      // is the entire update path — there is no client cache holding a stale
      // clip name.
      router.refresh();
    })();
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            Footage for section {sectionIndex + 1}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Searches Pexels and Pixabay — the same two sources the pipeline collects
            from, so anything offered here is something it could have picked itself.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-4">
          <form onSubmit={onSearch} className="flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="What should be on screen here?"
              aria-label="Search stock footage"
            />
            <Button type="submit" variant="outline" disabled={isSearching || !query.trim()}>
              {isSearching ? <Loader2 className="animate-spin" /> : <Search />}
              Search
            </Button>
          </form>

          {searchedQuery === null ? (
            <p className="text-muted-foreground text-sm">
              Search to see what is available. Clips are filtered to the ones the
              renderer can actually use — 6 to 30 seconds, 1080p or better, under
              40MB.
            </p>
          ) : results.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing usable came back for “{searchedQuery}”. A shorter, more
              concrete phrase — an object or a place rather than an idea — usually
              finds more.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {results.map((option) => (
                <li
                  key={`${option.source}-${option.externalId}`}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className="shrink-0">
                      {option.source === "PEXELS" ? "Pexels" : "Pixabay"}
                    </Badge>
                    <span className="text-muted-foreground truncate text-xs tabular-nums">
                      {option.width}×{option.height} · {Math.round(option.durationSeconds)}s
                    </span>
                  </div>

                  {option.alreadyUsedBySection !== null && (
                    <p className="text-muted-foreground text-xs">
                      Already playing under section {option.alreadyUsedBySection + 1}.
                    </p>
                  )}

                  <div className="mt-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => onChoose(option)}
                      disabled={swappingId !== null}
                    >
                      {swappingId === option.externalId ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Check />
                      )}
                      Use this
                    </Button>
                    {/* Opened rather than embedded. Pixabay's terms rule out
                      * hotlinking their CDN, and this app only stores a clip
                      * once it has been chosen — so a preview is a link to the
                      * provider's own file, not a player pointed at it. */}
                    <Button asChild size="sm" variant="ghost">
                      <a
                        href={option.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Preview ${option.source} clip ${option.externalId} in a new tab`}
                      >
                        <ExternalLink />
                      </a>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <p className="text-muted-foreground text-xs">
            Choosing a clip replaces this section&apos;s footage in storage. It does
            not change the video that already exists — that only happens on the next
            render.
          </p>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
