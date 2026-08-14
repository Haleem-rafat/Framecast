-- What YouTube needs to decide who a video is shown to, and what the upload
-- has never sent: `videos.insert` was called with a snippet carrying only
-- title, description and tags. With no `defaultLanguage`/`defaultAudioLanguage`
-- YouTube guesses the language from the text, and with no `categoryId` it
-- files the video under whatever it defaults to — both of which decide which
-- audience ever sees it in search, browse and recommendations.
--
-- On ChannelBrand rather than on Publication, because these are properties of
-- the channel and not of one video: a channel's videos are written, narrated
-- and categorised the same way every time. Making them per-video would ask
-- the operator the same two questions on every publish and let a single wrong
-- answer split a channel's catalogue across two categories.
--
-- Both columns are NOT NULL with a default, so every existing brand row is
-- backfilled by the ALTER itself and every channel without a brand row keeps
-- working untouched — `BrandService.resolve` returns the same two values for a
-- channel that has no row at all (see FALLBACK there, which mirrors these
-- defaults deliberately).
--
-- 'en' because every prompt, script and voice in this deployment is English
-- today. '27' is Education: this app publishes narrated explainers with a
-- cited SOURCES block, and Education is assignable in every region YouTube
-- publishes a category list for — which matters more than usual here, because
-- an unassignable category makes videos.insert answer 400 *after* the whole
-- file has been uploaded, and publish.service.ts deliberately keeps the failed
-- Publication row, which then blocks every retry.
ALTER TABLE "channel_brand"
  ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN "categoryId" TEXT NOT NULL DEFAULT '27';
