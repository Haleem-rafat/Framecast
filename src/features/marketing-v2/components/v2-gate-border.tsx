"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

import ElectricBorder from "@/components/react-bits/ElectricBorder";

/**
 * The amber crackle around a stage card that halts and waits for a person.
 *
 * `gated={false}` renders the children and nothing else, so the four ordinary
 * stages pay none of this — no canvas, no frame loop, no wrapper element with
 * its own stacking context.
 *
 * The colour is `--brand-amber-ink` converted to sRGB, per theme, because
 * ElectricBorder parses a hex string with its own `hexToRgba` and cannot take
 * a `var()`. It is the `-ink` stop rather than the decorative one on purpose:
 * on these two cards the colour *is* the information — amber means "this is
 * where it stops for you" — so it has to clear 3:1 rather than merely look
 * warm.
 *
 * Nothing is said only by the border. Each gated card also carries a solid
 * amber rule down its left edge, a "Stops here" chip and a "waits for you"
 * line, all of them plain text or plain CSS, so the claim survives with the
 * canvas switched off, the JavaScript never running, or the visitor reading
 * the page through a screen reader.
 */
export function V2GateBorder({
  gated,
  children,
}: {
  gated: boolean;
  children: React.ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Until the theme resolves there is no correct colour to draw, and the card
  // underneath is already complete — so the server render and the first client
  // render are both just the card.
  if (!gated || !mounted) return <>{children}</>;

  return (
    <ElectricBorder
      // oklch(0.55 0.15 65) → #a06a1e on light, oklch(0.81 0.14 65) → #fead56
      // on dark. Keep in step with `--brand-amber-ink` in globals.css.
      color={resolvedTheme === "dark" ? "#fead56" : "#a06a1e"}
      speed={0.7}
      chaos={0.08}
      borderRadius={16}
      className="h-full"
    >
      {children}
    </ElectricBorder>
  );
}
