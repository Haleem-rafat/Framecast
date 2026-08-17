"use client";

import ScrollVelocity from "@/components/react-bits/ScrollVelocity";

/**
 * Everything a single finished run contains, running edge to edge under the
 * hero.
 *
 * v1 states the same twelve things as a bordered four-column grid. This is the
 * same list as a scroll-reactive marquee: the row drifts on its own and speeds
 * up, slows down and reverses with the page's scroll velocity, which is React
 * Bits' ScrollVelocity doing the one thing it is genuinely good for — turning
 * an inventory into the sensation of a production line.
 *
 * The two amber entries are the gates. The colour *is* the information there,
 * so they take the `-ink` stop, which clears 3:1, rather than the decorative
 * one, which does not.
 *
 * What is deliberately not here is a logo cloud, which is what usually
 * occupies this slot on a landing page. It could only be third-party marks or
 * customer logos: the first implies an endorsement nobody has given, on a
 * domain currently under a Safe Browsing review, and the second would have to
 * be invented, because there are no customers yet.
 */
const INCLUDED: { label: string; gate?: boolean }[] = [
  { label: "A script from your template" },
  { label: "Sources for its claims" },
  { label: "Your approval of that script", gate: true },
  { label: "ElevenLabs narration" },
  { label: "Footage matched per line" },
  { label: "Captions burned into frame" },
  { label: "A music bed and sound effects" },
  { label: "Ken Burns motion on every clip" },
  { label: "A 1920 × 1080 master" },
  { label: "Title, description, tags, thumbnail" },
  { label: "Your approval of the finished cut", gate: true },
  { label: "The upload to your channel" },
];

function Row({ items }: { items: typeof INCLUDED }) {
  return (
    <span className="inline-flex items-center">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center">
          <span
            aria-hidden="true"
            className={`mx-4 size-1.5 shrink-0 rounded-full sm:mx-6 ${
              item.gate ? "bg-brand-amber-ink" : "bg-brand-violet/50"
            }`}
          />
          <span className={item.gate ? "text-brand-amber-ink" : undefined}>
            {item.label}
          </span>
        </span>
      ))}
    </span>
  );
}

export function V2Marquee() {
  return (
    <section
      aria-label="What is in every finished run"
      className="border-y py-10 sm:py-14"
    >
      <p className="text-muted-foreground mx-auto mb-6 w-full max-w-6xl px-6 font-mono text-[11px] tracking-[0.2em] uppercase sm:mb-8">
        In every finished run — twelve things, and you do two of them
      </p>

      {/* ScrollVelocity is itself `overflow-hidden`, so this cannot widen the
          page; the mask is only there so the row fades out at both edges
          instead of being guillotined by the viewport. */}
      <div className="[mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
        <ScrollVelocity
          texts={[
            <Row key="a" items={INCLUDED.slice(0, 6)} />,
            <Row key="b" items={INCLUDED.slice(6)} />,
          ]}
          velocity={38}
          numCopies={4}
          scrollerClassName="text-lg font-medium sm:text-2xl lg:text-3xl py-1.5"
        />
      </div>

      <p className="text-muted-foreground mx-auto mt-6 w-full max-w-6xl px-6 text-xs text-pretty sm:mt-8">
        The two amber ones are yours: the run halts at each of them until you
        say so.
      </p>
    </section>
  );
}
