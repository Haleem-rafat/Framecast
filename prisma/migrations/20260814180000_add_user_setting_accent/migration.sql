-- Per-operator accent colour. See the AccentColour enum's comment in
-- schema.prisma for why this is a curated set and not a free hex/oklch string:
-- an accent has to clear WCAG 4.5:1 in both light and dark, and one stored
-- colour cannot do that on both a white and a near-black ground.
CREATE TYPE "AccentColour" AS ENUM (
  'GRAPHITE',
  'BLUE',
  'INDIGO',
  'VIOLET',
  'PLUM',
  'ROSE',
  'ORANGE',
  'AMBER',
  'LIME',
  'EMERALD',
  'TEAL'
);

-- Purely additive, and GRAPHITE *is* the monochrome the studio renders today —
-- src/lib/accent.ts emits no CSS at all for it. So no backfill is needed and
-- no existing row changes appearance: an operator sees the same studio they saw
-- before this deploy until they pick a colour themselves.
ALTER TABLE "user_setting"
  ADD COLUMN "accent" "AccentColour" NOT NULL DEFAULT 'GRAPHITE';
