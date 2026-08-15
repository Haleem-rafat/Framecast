-- What the pictures under a channel's narration look like, and therefore which
-- stock providers its footage is searched for at all.
--
-- Framecast has only ever searched Pexels and Pixabay unfiltered, which is a
-- live-action result set: a search for "friendly dinosaur teaching numbers"
-- returns photoreal 3D creatures and stock of real dinosaur models. A script
-- can be written for children; until this column existed the pictures under it
-- could not be cartoons.
--
-- On channel_brand, beside `language`, `categoryId` and `madeForKids`, because
-- it is a property of the channel and not of one video. A channel that
-- alternates between cartoon and live-action footage does not have an
-- identity, and the operator here runs a kids channel alongside other channels
-- that genuinely want live action — one column per channel is exactly the
-- separation that needs.
--
-- NOT NULL DEFAULT 'LIVE_ACTION', so every existing brand row is backfilled by
-- the ALTER itself and every channel without a brand row keeps working
-- untouched (`BrandService.resolve` returns the same value for a channel with
-- no row — see FALLBACK there, which mirrors this default deliberately).
-- LIVE_ACTION is not a guess about anyone's audience: it is precisely what
-- every channel already collected, so no existing channel's footage changes.
CREATE TYPE "FootageStyle" AS ENUM ('LIVE_ACTION', 'CARTOON');

ALTER TABLE "channel_brand"
  ADD COLUMN "footageStyle" "FootageStyle" NOT NULL DEFAULT 'LIVE_ACTION';
