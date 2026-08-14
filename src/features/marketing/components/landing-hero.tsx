import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { AuroraBackground } from "@/components/ui/aurora-background";
import { Button } from "@/components/ui/button";

/**
 * Everything except the aurora is server-rendered: the headline, the sentence
 * under it and both calls to action are in the initial HTML with no JavaScript
 * involved. If the aurora never hydrates the hero still reads correctly.
 */
export function LandingHero() {
  return (
    <AuroraBackground
      containerClassName="border-b"
      // Masked to the top so the colour is a sky over the headline rather than
      // a field behind the whole section, which is both calmer and a fraction
      // of the pixels to composite.
      className="[mask-image:radial-gradient(150%_120%_at_50%_-20%,black_0%,transparent_72%)]"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 py-24 text-center sm:py-32 lg:py-44">
        <p className="text-muted-foreground bg-background/60 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs backdrop-blur-sm">
          <span className="from-brand-violet to-brand-cyan size-1.5 rounded-full bg-gradient-to-r" />
          Self-hosted video production. Free while in beta.
        </p>

        {/* 35 characters, two beats: what you do, what you get. Named brands
            appear as plain text only — this domain is under a Safe Browsing
            review and borrowing anyone's mark or brand colour is exactly the
            signal not to send. */}
        <h1 className="mt-6 text-[2.25rem] leading-[1.06] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl">
          Type a topic. Get a{" "}
          <span className="from-brand-violet via-brand-blue to-brand-cyan bg-gradient-to-r bg-clip-text text-transparent">
            finished video
          </span>
          .
        </h1>

        <p className="text-muted-foreground mt-6 max-w-2xl text-base text-pretty sm:text-lg">
          No writing, no recording, no editing. Framecast drafts a sourced
          script, narrates it with ElevenLabs, matches footage to every line,
          burns in the captions, lays music and motion under it, renders the cut
          and uploads it to YouTube with its title, description, tags and
          thumbnail.
        </p>

        {/* The approval gate is the most trust-building true thing about this
            product, so it gets its own object rather than a clause at the end
            of a paragraph nobody finishes. */}
        <p className="border-brand-violet/30 bg-background/50 mt-6 max-w-xl rounded-xl border px-4 py-3 text-sm text-pretty backdrop-blur-sm">
          <span className="font-medium">And it stops twice, for you.</span>{" "}
          <span className="text-muted-foreground">
            Nothing runs until you have approved the script. Nothing publishes
            until you have watched the finished video.
          </span>
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-up">
              Create an account
              <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>

        <p className="text-muted-foreground mt-5 max-w-md text-xs text-pretty">
          Free while in beta. Framecast is under active development, and every
          account is reviewed by an operator before it can be used.
        </p>
      </div>
    </AuroraBackground>
  );
}
