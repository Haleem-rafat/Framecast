-- What shape of video the renderer produces, chosen by the operator at the
-- moment they approve the script.
--
-- Until now there was one answer and it was compiled in: WIDTH/HEIGHT in
-- src/lib/ffmpeg-command.ts are 1920x1080, so every video this app has ever
-- made is landscape and nothing recorded that fact because nothing could
-- disagree with it. The vertical machinery existed only downstream, cutting
-- 9:16 clips out of a finished 16:9 render; making a vertical video the
-- primary output needs the choice to survive between the click that makes it
-- and the worker that acts on it, which is what this column is for.
CREATE TYPE "VideoFormat" AS ENUM ('LANDSCAPE', 'VERTICAL');

-- NOT NULL DEFAULT 'LANDSCAPE', and the default IS the backfill.
--
-- Every existing row is landscape as a matter of fact, not of assumption:
-- there has never been a code path that could produce anything else, so the
-- default records what those files already are rather than guessing at intent.
-- That is what makes this migration safe to run against a live database with
-- published videos in it — no row's meaning changes, and the video page's
-- hardcoded "1920x1080" label becomes a column read that returns the same
-- string it used to print.
ALTER TABLE "video"
  ADD COLUMN "format" "VideoFormat" NOT NULL DEFAULT 'LANDSCAPE';
