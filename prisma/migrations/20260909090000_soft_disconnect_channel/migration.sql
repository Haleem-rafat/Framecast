-- Let a channel be disconnected without being destroyed.
--
-- `ChannelService.disconnect` hard-deleted the row, with a stated and correct
-- reason: leaving encrypted upload credentials behind after somebody asks to
-- disconnect is not acceptable. What it did not account for is everything else
-- hanging off a Channel with `onDelete: Cascade` — ChannelBrand, Series,
-- ReleaseCadence, Publication — and `Project.channelId`, which is SetNull.
--
-- So disconnecting a channel silently deleted its entire configuration: the
-- footage style, the art style, the voice, the tone and niche, every schedule
-- built on it, its release cadence, and its publish history. Reconnecting then
-- created a NEW row, because `connect` upserts on (userId, youtubeChannelId)
-- and there was nothing left to match — leaving the operator's projects
-- unlinked and unable to publish at all. That happened on this deployment and
-- is what this migration exists to prevent recurring.
--
-- Making the credential columns nullable is what lets disconnect wipe the
-- secrets — the actual requirement — and soft-delete the row instead. `connect`
-- already upserts on (userId, youtubeChannelId) and already clears `deletedAt`,
-- so reconnecting revives the same row with its brand, series and cadence still
-- attached. That path was already built; nothing could reach it while the row
-- was being deleted out from under it.
--
-- Existing rows keep their tokens: nullable widens what the column accepts and
-- changes nothing already stored.
ALTER TABLE "channel" ALTER COLUMN "accessToken" DROP NOT NULL;
ALTER TABLE "channel" ALTER COLUMN "refreshToken" DROP NOT NULL;
ALTER TABLE "channel" ALTER COLUMN "tokenExpiresAt" DROP NOT NULL;
