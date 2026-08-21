"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * The style picker, as a grid rather than a dropdown.
 *
 * A `<Select>` shows one option's name at a time and renders its description
 * below the field, so comparing six looks meant opening the menu six times
 * having seen none of them — for a decision that is entirely visual. This shows
 * every option at once, with a sample of what it actually draws.
 *
 * Used for both art style and footage style, which had the same control and the
 * same problem, which is why it is `StylePicker` and not `ArtStylePicker`.
 *
 * ── Why real radios ────────────────────────────────────────────────────────
 * The cards are labels wrapping a visually-hidden `<input type="radio">`, not
 * divs with click handlers. Keyboard support, arrow-key traversal within the
 * group, form association and the accessible name all come from the platform
 * that way; a div grid would need every one of them reimplemented, and would
 * get at least one wrong.
 *
 * ── Why the samples are files ──────────────────────────────────────────────
 * Static, under `public/art-styles/`, generated once by
 * `scripts/generate-style-samples.ts` and committed. Same reasoning
 * `art-styles.ts` gives for being code rather than database rows: the app ships
 * with them whether or not a seed has run. A missing file falls back to a
 * neutral tile rather than a broken image, because the picker has to work
 * before anyone has spent the thirty-five cents — and because footage styles
 * that search stock rather than generate have nothing to sample.
 */

export interface StyleOption {
  value: string;
  label: string;
  description: string;
}

interface StylePickerProps {
  /** The radio group's shared name. Also what the sample path is looked up
   *  under, so two pickers on one screen cannot collide. */
  name: string;
  options: readonly StyleOption[];
  /** `null` for "nobody has chosen", which is a real state for art style. */
  value: string | null;
  onChange: (value: string) => void;
  /** Where a sample for this option would live, or null for a picker whose
   *  options cannot be sampled. */
  sampleSrc?: (value: string) => string;
  id?: string;
}

export function StylePicker({
  name,
  options,
  value,
  onChange,
  sampleSrc,
  id,
}: StylePickerProps) {
  // Which samples failed to load, so a missing file degrades to the neutral
  // tile once rather than retrying on every render.
  const [missing, setMissing] = useState<Set<string>>(new Set());

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={name}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {options.map((option) => {
        const selected = option.value === value;
        const src = sampleSrc?.(option.value);
        const showSample = src !== undefined && !missing.has(option.value);

        return (
          <label
            key={option.value}
            className={[
              "group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border",
              "transition-colors focus-within:ring-2 focus-within:ring-ring",
              selected
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/40",
            ].join(" ")}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />

            <div className="bg-muted relative aspect-[3/2] w-full">
              {showSample ? (
                <Image
                  src={src}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 20rem, (min-width: 640px) 50vw, 100vw"
                  className="object-cover"
                  onError={() =>
                    setMissing((current) => new Set(current).add(option.value))
                  }
                />
              ) : (
                <span className="text-muted-foreground flex h-full items-center justify-center text-xs">
                  No sample yet
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1 p-3">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-muted-foreground text-xs leading-relaxed">
                {option.description}
              </span>
            </div>
          </label>
        );
      })}
    </div>
  );
}
