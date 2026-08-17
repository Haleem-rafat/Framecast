import Link from "next/link";
import { KeyRound, ServerCog, ShieldCheck } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { V2Reveal } from "@/features/marketing-v2/components/v2-reveal";
import { V2BandHeading } from "@/features/marketing-v2/components/v2-shell";

/**
 * The shadcn Accordion, which is Radix underneath — so the questions are
 * reachable by keyboard and announced correctly. React Bits has no disclosure
 * primitive and its animated alternatives are not accessible replacements for
 * one, so this section deliberately uses none of them.
 */
const QUESTIONS = [
  {
    q: "Does it publish without me?",
    a: (
      <>
        No. A run stops twice and waits: once when the script is written, before
        anything that costs money has run, and once when the video is rendered,
        before anything is uploaded. If you do not approve the cut, nothing
        leaves the machine.
      </>
    ),
  },
  {
    q: "What does it ask for on my YouTube account?",
    a: (
      <>
        Permission to read the channel, to upload videos you have approved, and
        to read that channel&apos;s own analytics and estimated revenue so the
        studio can show you how a video did against what it cost. Nothing else —
        it never edits, deletes or comments. The{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          privacy policy
        </Link>{" "}
        lists each permission and why it is requested.
      </>
    ),
  },
  {
    q: "Who pays for the AI?",
    a: (
      <>
        You do, directly to the providers, using the API keys you supply.
        Framecast records what each script, voice and image cost and shows it
        against the video it went into, but it does not cap spending and it
        never bills you itself.
      </>
    ),
  },
  {
    q: "Where does my data live?",
    a: (
      <>
        On one server. The application, the renderer and the PostgreSQL database
        all run on a single machine, and the database accepts no connections
        from the internet. Access tokens and API keys are encrypted at rest
        before they are written.
      </>
    ),
  },
  {
    q: "Can I sign up right now?",
    a: (
      <>
        You can create an account, and an operator reviews it before it can be
        used — Framecast is a private studio tool rather than a public service,
        so accounts are not activated automatically.
      </>
    ),
  },
  {
    q: "Is the footage licensed?",
    a: (
      <>
        Clips come from stock footage providers, matched to the script line by
        line. You remain responsible for what you publish to your own channel,
        including complying with YouTube&apos;s policies — the{" "}
        <Link href="/terms" className="underline underline-offset-4">
          terms
        </Link>{" "}
        set out where that line falls.
      </>
    ),
  },
];

export function V2Faq() {
  return (
    <section id="faq" className="border-t py-20 sm:py-28 lg:py-32">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-20">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <V2BandHeading
            eyebrow="FAQ"
            title="Questions worth"
            accent="asking first"
          >
            Mostly about control, money and what leaves the machine.
          </V2BandHeading>
        </div>

        <Accordion type="single" collapsible className="w-full">
          {QUESTIONS.map((item) => (
            <AccordionItem key={item.q} value={item.q}>
              <AccordionTrigger className="text-left text-base">
                {item.q}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm text-pretty">
                {item.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

/**
 * The closing section is the operational truth rather than a testimonial wall:
 * what it runs on, whose keys pay for it, and what state the project is in.
 * Every claim has to be true of the thing that actually exists.
 */
const FACTS = [
  {
    icon: ServerCog,
    title: "One machine",
    body: "Framecast is self-hosted. The app, the renderer and the database all run on a single server, and that database accepts no connections from the internet.",
  },
  {
    icon: KeyRound,
    title: "Your keys",
    body: "The AI providers are configured with keys you supply, and each generation’s cost is recorded against the video it produced.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing posts itself",
    body: "A connected channel is only ever written to for a cut you approved. Framecast asks for no Google permission beyond reading that channel and uploading to it.",
  },
];

export function V2Cta() {
  return (
    <section className="relative isolate overflow-hidden border-t">
      <div
        aria-hidden="true"
        className="from-brand-violet/12 via-brand-blue/6 absolute inset-0 -z-10 bg-gradient-to-tr to-transparent"
      />

      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28 lg:py-32">
        <V2Reveal>
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.6rem] lg:leading-[1.1]">
                Your channel, your keys,{" "}
                <span className="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent">
                  your machine.
                </span>
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
                Framecast is a private studio tool under active development, not
                a public service. Create an account and an operator will review
                it before it can be used.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button asChild size="lg">
                  <Link href="/sign-up">Create an account</Link>
                </Button>
                <Button asChild size="lg" variant="ghost">
                  <Link href="/privacy">How your data is used</Link>
                </Button>
              </div>
            </div>

            <dl className="space-y-6">
              {FACTS.map((fact) => (
                <div key={fact.title} className="flex gap-4">
                  <fact.icon className="text-brand-violet-ink mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <dt className="text-sm font-medium">{fact.title}</dt>
                    <dd className="text-muted-foreground mt-1 text-sm text-pretty">
                      {fact.body}
                    </dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </V2Reveal>
      </div>
    </section>
  );
}
