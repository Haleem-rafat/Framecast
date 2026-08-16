import Link from "next/link";
import { Lock, MonitorPlay, Smartphone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { artStyleLabel } from "@/lib/art-styles";
import { footageStyleLabel } from "@/lib/footage-styles";
import { categoryTitle } from "@/lib/youtube-categories";
import { VIDEO_FORMATS } from "@/lib/video-format";
import type { SeriesDetail } from "@/services/series.service";

/**
 * What every episode of this show will be made with, and — the part that
 * matters — which of it this series decides and which of it the channel does.
 *
 * The two halves are separate cards with different headings on purpose. A
 * series cannot override anything in the second one: the renderer resolves the
 * brand through `video -> project -> channel` inside the footage, render,
 * publish and shorts services, so a per-series art style would be a value this
 * screen showed and the renderer ignored. Rather than leave that as an absence
 * the operator has to infer, the inherited values are printed here in full,
 * marked, and linked to the single screen that changes them — where changing
 * one changes it for every series on the channel, which is the whole point of
 * a channel having an identity.
 *
 * A server component: all of it is read from rows the page already has, and
 * none of it is interactive.
 */

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[12rem_1fr] sm:gap-4 sm:py-1.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-sm">
        {value}
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </dd>
    </div>
  );
}

/** Null means "nobody has chosen", which is a real state rather than a gap to
 *  paper over with a plausible-looking default — see `ChannelBranding`. */
function Unset({ what }: { what: string }) {
  return <span className="text-muted-foreground italic">No {what} chosen</span>;
}

export function SeriesRecipe({ series }: { series: SeriesDetail }) {
  const facts = VIDEO_FORMATS[series.format];
  const FormatIcon = series.format === "VERTICAL" ? Smartphone : MonitorPlay;
  const answered = Object.entries(series.variables).filter(([, value]) =>
    value.trim(),
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>This series decides</CardTitle>
          <CardDescription>
            Answered once, here. No episode is ever asked again.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <dl className="divide-border divide-y sm:divide-y-0">
            <Row
              label="Script style"
              value={
                <Link
                  href="/prompts"
                  className="underline-offset-4 hover:underline"
                >
                  {series.scriptStyleName}
                </Link>
              }
              hint="Writes every episode. Before this, the style was picked per video in the script panel."
            />
            <Row
              label="Format"
              value={
                <span className="flex items-center gap-2">
                  <FormatIcon className="size-4" />
                  {facts.label}
                  <span className="text-muted-foreground">
                    {facts.dimensions} · {facts.aspect}
                  </span>
                </span>
              }
              hint="Before this, the shape was picked per video in the approve dialog."
            />
            <Row label="Cadence" value={series.cadence} />
            <Row
              label="Project"
              value={
                <Link
                  href="/projects"
                  className="underline-offset-4 hover:underline"
                >
                  {series.projectName}
                </Link>
              }
              hint="Where the episodes are filed."
            />
            {answered.length > 0 && (
              <Row
                label="Prompt answers"
                value={
                  <ul className="space-y-0.5">
                    {answered.map(([key, value]) => (
                      <li key={key}>
                        <span className="text-muted-foreground font-mono text-xs">
                          {key}
                        </span>{" "}
                        {value}
                      </li>
                    ))}
                  </ul>
                }
                hint="The same direction on every episode — only the topic changes."
              />
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-4" />
            Inherited from {series.channelTitle}
          </CardTitle>
          <CardDescription>
            These win, and a series cannot override them — every series on this
            channel looks and sounds the same, which is what makes it one
            channel.{" "}
            <Link
              href={`/channels/${series.channelId}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              Change them on the channel
            </Link>{" "}
            and every series follows.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <dl className="divide-border divide-y sm:divide-y-0">
            <Row
              label="Niche"
              value={series.brand.niche ?? <Unset what="niche" />}
            />
            <Row label="Tone" value={series.brand.tone ?? <Unset what="tone" />} />
            <Row
              label="Voice"
              value={
                series.brand.voiceName ??
                (series.brand.voiceId ? (
                  <span className="font-mono text-xs">{series.brand.voiceId}</span>
                ) : (
                  <span className="text-muted-foreground italic">
                    The deployment&apos;s default voice
                  </span>
                ))
              }
            />
            <Row
              label="Music"
              value={series.brand.musicQuery ?? <Unset what="music" />}
            />
            <Row label="Footage" value={footageStyleLabel(series.brand.footageStyle)} />
            <Row
              label="Art style"
              value={
                series.brand.artStyle ? (
                  artStyleLabel(series.brand.artStyle)
                ) : (
                  <Unset what="art style" />
                )
              }
              hint="Only read when the footage is illustrated."
            />
            <Row label="Language" value={series.brand.language} />
            <Row label="Category" value={categoryTitle(series.brand.categoryId)} />
            <Row
              label="Made for kids"
              value={
                <Badge variant={series.brand.madeForKids ? "default" : "secondary"}>
                  {series.brand.madeForKids ? "Yes" : "No"}
                </Badge>
              }
              hint="A COPPA declaration sent on every upload from this channel."
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
