-- Which ElevenLabs voice reads a channel's narration, and the name it had when
-- it was chosen.
--
-- Until now the voice was `env.ELEVENLABS_VOICE_ID` — one voice, from one
-- environment variable, for every video on every channel. `UserSetting` has a
-- `defaultVoiceId` column that looks like it fixes that and is read by nothing;
-- and even wired up it could not, because the operator runs a finance channel
-- and a children's channel from the same account and needs both voices at
-- once. The voice is a property of the channel, so it lives on `channel_brand`
-- beside `tone`, `niche`, `madeForKids` and `footageStyle`.
--
-- Both columns are NULLable with no default and no backfill, which is the
-- whole compatibility story: NULL means "the deployment's ELEVENLABS_VOICE_ID",
-- `BrandService.resolve` applies that fallback, and every channel that existed
-- before this migration narrates in exactly the voice it did yesterday without
-- the operator doing anything. There is deliberately no DEFAULT here — a
-- default would have to name a specific voice id, and this app must never
-- assert that a given voice exists on the operator's ElevenLabs account.
--
-- `voiceName` is display only (it fills `voice_over.voiceName`, which the
-- narration library lists) and is meaningless without `voiceId`; clearing the
-- voice clears the name with it.
ALTER TABLE "channel_brand"
  ADD COLUMN "voiceId" TEXT,
  ADD COLUMN "voiceName" TEXT;
