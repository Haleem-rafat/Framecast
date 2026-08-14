import type { Metadata } from "next";
import { Image as ImageIcon, Layers, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { StatCard } from "@/components/shared/stat-card";
import { ThumbnailCard } from "@/features/studio/components/thumbnail-card";
import { requireUser } from "@/server/session";
import { studioService } from "@/services/studio.service";

export const metadata: Metadata = { title: "Thumbnails" };

export default async function StudioThumbnailPage() {
  const user = await requireUser();

  const [thumbnails, readyWithoutThumbnail] = await Promise.all([
    studioService.listThumbnails(user.id),
    studioService.countReadyVideosWithoutThumbnail(user.id),
  ]);

  const versionCount = thumbnails.reduce(
    (total, entry) => total + entry.versions.length,
    0,
  );

  return (
    <>
      <PageHeader
        title="Thumbnails"
        description="Every thumbnail the pipeline has generated, every attempt behind it, and which one each video will publish with."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Videos with a thumbnail"
          value={String(thumbnails.length)}
          icon={ImageIcon}
          hint="Generated at the end of a render"
        />
        <StatCard
          label="Versions generated"
          value={String(versionCount)}
          icon={Layers}
          hint="Nothing is ever overwritten — each attempt is kept"
        />
        <StatCard
          label="Ready with none"
          value={String(readyWithoutThumbnail)}
          icon={TriangleAlert}
          tone={readyWithoutThumbnail > 0 ? "danger" : "default"}
          hint="These would publish with a frame YouTube picks"
        />
      </div>

      {/* One region for the whole gallery rather than one per card. A grid of
       * thumbnails where every tile arrives on its own schedule reads as a page
       * still loading, not as a page that is alive — and the cards refresh
       * themselves after a version is promoted, which is the other reason they
       * must not each own an entrance. */}
      <Reveal>
        {thumbnails.length === 0 ? (
          <EmptyState
            icon={ImageIcon}
            title="No thumbnails yet"
            description="A thumbnail is generated automatically once a video finishes rendering. Every attempt is kept, so you can come back and compare them here."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {thumbnails.map((entry) => (
              <ThumbnailCard key={entry.videoId} entry={entry} />
            ))}
          </div>
        )}
      </Reveal>

      <p className="text-muted-foreground text-xs text-balance">
        A thumbnail is only attached to a video during its publish, so the
        active version is what matters right up until then and nothing
        afterwards. YouTube also only accepts a custom thumbnail from a
        verified channel — an unverified one publishes fine and simply keeps
        the frame YouTube chose.
      </p>
    </>
  );
}
