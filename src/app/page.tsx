import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Mic, Film, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  MarketingHeading,
  MarketingShell,
} from "@/features/marketing/components/marketing-shell";

export const metadata: Metadata = {
  title: "Framecast — automated video production",
  description:
    "Framecast turns a topic into a finished, published video: script, narration, footage, render, upload — with a human approving the script and the final cut.",
};

const STAGES = [
  {
    icon: FileText,
    title: "Script",
    body: "A topic becomes a sourced, spoken-word script from a prompt template you control.",
  },
  {
    icon: Mic,
    title: "Narration",
    body: "The approved script is voiced, then split into scenes and matched to footage.",
  },
  {
    icon: Film,
    title: "Render",
    body: "Footage, narration and captions are assembled into a finished video and short clips.",
  },
  {
    icon: Upload,
    title: "Publish",
    body: "Once you approve the cut, it is uploaded to the connected channel with its metadata.",
  },
];

export default function HomePage() {
  return (
    <MarketingShell>
      <div className="space-y-12">
        <section className="space-y-6">
          <MarketingHeading
            title="A production line for video, with a person still in the loop."
            subtitle="Framecast takes a topic through script, narration, footage, render and publishing. Two steps are deliberately manual: approving the script before any money is spent, and approving the finished cut before anything is published."
          />

          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/privacy">How your data is used</Link>
            </Button>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          {STAGES.map((stage) => (
            <div key={stage.title} className="space-y-2 rounded-xl border p-5">
              <stage.icon className="text-muted-foreground size-5" />
              <h2 className="font-medium">{stage.title}</h2>
              <p className="text-muted-foreground text-sm text-pretty">
                {stage.body}
              </p>
            </div>
          ))}
        </section>

        <section className="text-muted-foreground space-y-3 border-t pt-8 text-sm">
          <p className="text-pretty">
            Framecast is a private studio tool, not a public service. Accounts are
            provisioned by the operator; there is no self-registration. It is under
            active development and not all stages above are complete.
          </p>
          <p className="text-pretty">
            When a YouTube channel is connected, Framecast requests only the
            permissions needed to read that channel and publish videos you have
            approved. It never posts without your approval, and it does not read
            or use your Google data for anything else. See the{" "}
            <Link href="/privacy" className="text-foreground underline underline-offset-4">
              privacy policy
            </Link>
            .
          </p>
        </section>
      </div>
    </MarketingShell>
  );
}
