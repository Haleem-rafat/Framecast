"use client";

import { motion } from "motion/react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Aceternity's TextGenerateEffect — words un-blurring one after another, the
 * shape of a model writing — rebuilt on the declarative API.
 *
 * Changes from upstream:
 * - No hard-coded `font-bold`, `text-2xl` or `text-black dark:text-white`. The
 *   effect inherits type and colour from wherever it is used, so it can sit
 *   inside a body paragraph instead of only as a display heading.
 * - Triggered by `whileInView` with `once: true` rather than on mount, so the
 *   words are written when the reader actually reaches them, and exactly once.
 *   `useAnimate` + a `[scope.current]` effect dependency (which React does not
 *   track) is gone with it.
 * - Reduced motion renders the finished text immediately, with no wrapper
 *   elements animating at all.
 */
export function TextGenerateEffect({
  words,
  className,
  duration = 0.4,
  stagger = 0.05,
}: {
  words: string;
  className?: string;
  /** Seconds each word takes to resolve. */
  duration?: number;
  /**
   * Seconds between one word starting and the next. Kept low: a sentence of
   * thirty words at 0.12 takes four seconds to finish writing itself, which is
   * longer than anyone will wait to read one example.
   */
  stagger?: number;
}) {
  const reduceMotion = usePrefersReducedMotion();

  if (reduceMotion) {
    return <span className={className}>{words}</span>;
  }

  return (
    <span className={cn("inline", className)}>
      {words.split(" ").map((word, index) => (
        <motion.span
          // Words repeat within a sentence, so the word alone is not a key.
          key={`${word}-${index}`}
          className="inline-block whitespace-pre"
          initial={{ opacity: 0, filter: "blur(8px)" }}
          whileInView={{ opacity: 1, filter: "blur(0px)" }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration, delay: index * stagger }}
        >
          {word}{" "}
        </motion.span>
      ))}
    </span>
  );
}
