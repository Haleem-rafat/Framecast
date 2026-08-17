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
      {/* Tighter on a phone than it was. At `py-24` with the stack below it,
          the first screen of a 390px device held the badge, the headline and
          most of a seven-line paragraph — and the buttons the whole page exists
          to get pressed sat under the fold, behind the floating dock. The
          desktop rhythm is untouched from `sm` up. */}
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 py-14 text-center sm:py-32 lg:py-44">
        <p className="text-muted-foreground bg-background/60 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs backdrop-blur-sm">
          <span className="from-brand-violet to-brand-cyan size-1.5 rounded-full bg-gradient-to-r" />
          Self-hosted video production. Free while in beta.
        </p>

        {/* 35 characters, two beats: what you do, what you get. Named brands
            appear as plain text only — this domain is under a Safe Browsing
            review and borrowing anyone's mark or brand colour is exactly the
            signal not to send. */}
        <h1 className="mt-5 text-[2.25rem] leading-[1.06] font-semibold tracking-tight text-balance sm:mt-6 sm:text-6xl lg:text-7xl">
          Type a topic. Get a{" "}
          {/* Ink stops, not decorative ones. `bg-clip-text` makes the gradient
              the text's actual colour, so its pale end has to be readable: the
              decorative cyan scored 2.18:1 on the light ground, under even the
              3:1 large-text floor, and "video" was the faintest word in the
              largest sentence on the page. The ink triple is 5.17/4.74/4.83,
              and in the dark theme ink and decoration are the same values, so
              nothing there changes. */}
          <span className="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent">
            finished video
          </span>
          .
        </h1>

        {/* Two sentences, not one seven-clause list: the first says what you
            stop doing, the second is the pipeline in the order it runs. A
            reader who quits after the first has still got the point. */}
        <p className="text-muted-foreground mt-5 max-w-2xl text-base text-pretty sm:mt-6 sm:text-lg">
          No writing, no recording, no editing. Framecast drafts a sourced
          script, narrates it with ElevenLabs, matches footage to every line,
          then renders the cut with burned-in captions, music and motion and
          uploads it to YouTube — title, description, tags and thumbnail
          included.
        </p>

        {/* The approval gate is the most trust-building true thing about this
            product, so it gets its own object rather than a clause at the end
            of a paragraph nobody finishes. */}
        {/* `order-last` on a phone, in place on a laptop.
            This is the most trust-building sentence on the page and it still
            should not stand between a first-time visitor and the button. On a
            narrow screen it moves below the actions; from `sm` up, where the
            whole hero is visible at once, the reading order is unchanged. */}
        <p className="border-brand-violet/30 bg-background/50 order-last mt-6 max-w-xl rounded-xl border px-4 py-3 text-sm text-pretty backdrop-blur-sm sm:order-none">
          <span className="font-medium">And it stops twice, for you.</span>{" "}
          <span className="text-muted-foreground">
            Nothing runs until you have approved the script. Nothing publishes
            until you have watched the finished video.
          </span>
        </p>

        {/* The button itself stays the app's plain near-black `--primary`. The
            emphasis comes from around it instead: a soft brand halo sitting
            behind the primary action only, so it reads as the lit thing on the
            section without the button being recoloured. `blur` on a static
            element is composited once, not per frame. */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3 sm:mt-8">
          <div className="relative">
            <span
              aria-hidden="true"
              className="from-brand-violet via-brand-blue to-brand-cyan absolute -inset-2 -z-10 rounded-full bg-gradient-to-r opacity-40 blur-lg"
            />
            <Button asChild size="lg">
              <Link href="/sign-up">
                Create an account
                <ArrowRight />
              </Link>
            </Button>
          </div>
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
