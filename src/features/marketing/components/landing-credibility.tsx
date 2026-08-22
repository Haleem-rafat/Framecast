import { CREDIBILITY } from "@/features/marketing/landing-copy";

/**
 * Block 3 of the landing page: why the reader should believe any of it.
 *
 * A strong hook plus a strong value proposition sounds too good to be true,
 * and the reader's next thought is "who are you?". Answering it before they
 * leave to find out is the entire job of this section.
 *
 * ## What is deliberately not here
 *
 * No testimonials, no customer logos, no "trusted by N creators", no founder
 * bio. Not an oversight and not modesty — none of them can be written truthfully
 * today, and a fabricated one is the single thing on a landing page a reader
 * can catch out. An empty section costs less than a false one.
 *
 * What is here instead is the part of credibility that IS available: checkable
 * facts about what the system does, what it costs, and what it refuses to do.
 * The last of those is doing the most work. A page that lists what a product
 * will not do is making a claim the reader can test, and "it refuses more than
 * it does" is the honest summary of a pipeline with two gates and a render that
 * would rather stop than publish a hole.
 *
 * `CREDIBILITY.operatorNote` is the marked place for a real bio. It renders
 * when somebody fills it in and is absent until then.
 */
export function LandingCredibility() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {CREDIBILITY.heading}
        </h2>
      </div>

      <dl className="mt-12 grid gap-8 sm:grid-cols-3">
        {CREDIBILITY.facts.map((fact) => (
          <div key={fact.claim} className="flex flex-col gap-2">
            <dt className="text-base font-medium text-balance">{fact.claim}</dt>
            <dd className="text-muted-foreground text-sm text-pretty">{fact.detail}</dd>
          </div>
        ))}
      </dl>

      {CREDIBILITY.operatorNote ? (
        <p className="text-muted-foreground mx-auto mt-10 max-w-2xl text-center text-sm text-pretty">
          {CREDIBILITY.operatorNote}
        </p>
      ) : null}
    </section>
  );
}
