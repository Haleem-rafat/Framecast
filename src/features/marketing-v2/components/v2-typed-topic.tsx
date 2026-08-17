"use client";

import TextType from "@/components/react-bits/TextType";

/**
 * The example topic, typed in.
 *
 * This is the one place on the page where an animation is doing the same job
 * the product does: the whole pitch is "you type a topic", and a line that
 * types itself is that sentence acted out rather than restated. It is inside a
 * figure already labelled "Example", next to the script it would produce.
 *
 * `loop={false}` — it types once, when it scrolls into view, and then stops.
 * A topic that keeps deleting and retyping itself beside the words "no real
 * run is being quoted here" would read as a demo reel, and this figure is
 * carrying a claim about what the software does.
 *
 * The text is a real text node throughout, appearing a character at a time, so
 * a crawler that does not run JavaScript sees nothing here — which is why the
 * `<figcaption>` above it and the script below it are plain static markup and
 * carry the section's meaning on their own. Under `prefers-reduced-motion` the
 * vendored component renders the whole string at once with no cursor.
 */
export function V2TypedTopic({ topic }: { topic: string }) {
  return (
    <TextType
      as="p"
      text={topic}
      typingSpeed={26}
      initialDelay={180}
      loop={false}
      startOnVisible
      showCursor
      cursorCharacter="▍"
      className="mt-2 text-sm font-medium"
      cursorClassName="text-brand-violet-ink"
    />
  );
}
