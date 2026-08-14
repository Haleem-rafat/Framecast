import type { Metadata } from "next";
import { FileText, Film, Quote, Type } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { StatCard } from "@/components/shared/stat-card";
import { ScriptLibraryTable } from "@/features/studio/components/script-library-table";
import { requireUser } from "@/server/session";
import { studioService } from "@/services/studio.service";

export const metadata: Metadata = { title: "Script library" };

export default async function StudioScriptPage() {
  const user = await requireUser();
  const scripts = await studioService.listScripts(user.id);

  // Every figure below is counted over scripts that *have* an active version.
  // One without a version has no narration at all, and filing it under
  // "missing cues" would put a video that never got a script alongside ones
  // whose model simply returned prose.
  const activeVersions = scripts.flatMap((entry) => entry.activeVersion ?? []);
  const totalWords = activeVersions.reduce(
    (total, version) => total + version.wordCount,
    0,
  );
  const withoutCues = activeVersions.filter(
    (version) => version.cueCount === 0,
  ).length;
  const withoutSources = activeVersions.filter(
    (version) => version.sourceCount === 0,
  ).length;

  return (
    <>
      <PageHeader
        title="Script library"
        description="Every script across your videos, with the two things only the database knows: whether it carries b-roll cues, and whether it carries citations."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Scripts"
          value={String(scripts.length)}
          icon={FileText}
          hint={`${activeVersions.length} with an active version`}
        />
        <StatCard
          label="Words written"
          value={totalWords.toLocaleString()}
          icon={Type}
          hint="Across every active version"
        />
        <StatCard
          label="Without cues"
          value={String(withoutCues)}
          icon={Film}
          // Not a failure — every script written before cues existed is in
          // here, and they render fine — so no danger tone. It is the one
          // thing that quietly changes what the finished video looks like.
          hint="Footage falls back to the topic pool"
        />
        <StatCard
          label="Without sources"
          value={String(withoutSources)}
          icon={Quote}
          hint="Nothing to put in the description's SOURCES block"
        />
      </div>

      <Reveal>
        <ScriptLibraryTable scripts={scripts} />
      </Reveal>

      <p className="text-muted-foreground text-xs text-balance">
        Scripts are written, edited and approved on a video&apos;s own page —
        this library is for reading across them. A script with no cues still
        renders: footage is chosen from the video&apos;s topic instead of from
        the sentence being narrated. A script with no sources publishes with no
        citations unless it carries an inline SOURCES section, which only
        hand-written scripts do.
      </p>
    </>
  );
}
