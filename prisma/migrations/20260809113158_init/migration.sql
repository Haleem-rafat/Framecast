-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('DRAFT', 'QUEUED', 'GENERATING', 'RENDERING', 'READY', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "SceneStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'MUSIC', 'SUBTITLE');

-- CreateEnum
CREATE TYPE "RenderStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PublishVisibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('PENDING', 'SCHEDULED', 'UPLOADING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "PromptCategory" AS ENUM ('SCRIPT', 'THUMBNAIL', 'SCENE', 'TITLE', 'DESCRIPTION', 'TAGS');

-- CreateEnum
CREATE TYPE "AiProviderType" AS ENUM ('OPENAI', 'ANTHROPIC', 'GEMINI', 'ELEVENLABS', 'GOOGLE_VEO', 'RUNWAY', 'KLING', 'REPLICATE', 'PIKA', 'LUMA');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "ThemePreference" AS ENUM ('LIGHT', 'DARK', 'SYSTEM');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel" (
    "id" UUID NOT NULL,
    "youtubeChannelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "userId" UUID NOT NULL,

    CONSTRAINT "channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_statistic" (
    "id" UUID NOT NULL,
    "subscriberCount" BIGINT NOT NULL DEFAULT 0,
    "viewCount" BIGINT NOT NULL DEFAULT 0,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channelId" UUID NOT NULL,

    CONSTRAINT "channel_statistic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "userId" UUID NOT NULL,
    "channelId" UUID,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "topic" TEXT,
    "status" "VideoStatus" NOT NULL DEFAULT 'DRAFT',
    "failureReason" TEXT,
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "userId" UUID NOT NULL,
    "projectId" UUID NOT NULL,

    CONSTRAINT "video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_status_event" (
    "id" UUID NOT NULL,
    "from" "VideoStatus",
    "to" "VideoStatus" NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "videoId" UUID NOT NULL,

    CONSTRAINT "video_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "script" (
    "id" UUID NOT NULL,
    "activeVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoId" UUID NOT NULL,

    CONSTRAINT "script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "script_version" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT,
    "model" TEXT,
    "provider" "AiProviderType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scriptId" UUID NOT NULL,

    CONSTRAINT "script_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_over" (
    "id" UUID NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "voiceId" TEXT NOT NULL,
    "voiceName" TEXT,
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "emotion" TEXT,
    "audioUrl" TEXT,
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoId" UUID NOT NULL,

    CONSTRAINT "voice_over_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thumbnail" (
    "id" UUID NOT NULL,
    "activeVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoId" UUID NOT NULL,

    CONSTRAINT "thumbnail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thumbnail_version" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" "AiProviderType",
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "thumbnailId" UUID NOT NULL,

    CONSTRAINT "thumbnail_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene" (
    "id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "narration" TEXT,
    "status" "SceneStatus" NOT NULL DEFAULT 'PENDING',
    "startSeconds" DOUBLE PRECISION,
    "endSeconds" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoId" UUID NOT NULL,

    CONSTRAINT "scene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "url" TEXT,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "provider" "AiProviderType",
    "model" TEXT,
    "prompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "sceneId" UUID,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_job" (
    "id" UUID NOT NULL,
    "status" "RenderStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "outputUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoId" UUID NOT NULL,

    CONSTRAINT "render_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_log" (
    "id" UUID NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renderJobId" UUID NOT NULL,

    CONSTRAINT "render_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication" (
    "id" UUID NOT NULL,
    "youtubeVideoId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[],
    "playlistId" TEXT,
    "visibility" "PublishVisibility" NOT NULL DEFAULT 'PRIVATE',
    "status" "PublishStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoId" UUID NOT NULL,
    "channelId" UUID NOT NULL,

    CONSTRAINT "publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_analytic" (
    "id" UUID NOT NULL,
    "views" BIGINT NOT NULL DEFAULT 0,
    "likes" BIGINT NOT NULL DEFAULT 0,
    "comments" BIGINT NOT NULL DEFAULT 0,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "clickThroughRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "averageViewSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "watchTimeMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subscribersGained" INTEGER NOT NULL DEFAULT 0,
    "estimatedRevenue" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "capturedFor" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicationId" UUID NOT NULL,

    CONSTRAINT "video_analytic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_template" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "PromptCategory" NOT NULL,
    "content" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "userId" UUID NOT NULL,

    CONSTRAINT "prompt_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_variable" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "defaultValue" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "promptTemplateId" UUID NOT NULL,

    CONSTRAINT "prompt_variable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credential" (
    "id" UUID NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "label" TEXT,
    "encryptedKey" TEXT NOT NULL,
    "keyLastFour" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "userId" UUID NOT NULL,

    CONSTRAINT "provider_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_usage" (
    "id" UUID NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "operation" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "succeeded" BOOLEAN NOT NULL DEFAULT true,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credentialId" UUID,

    CONSTRAINT "provider_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" UUID NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" UUID,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_setting" (
    "id" UUID NOT NULL,
    "theme" "ThemePreference" NOT NULL DEFAULT 'SYSTEM',
    "defaultScriptProvider" "AiProviderType" NOT NULL DEFAULT 'OPENAI',
    "defaultVoiceProvider" "AiProviderType" NOT NULL DEFAULT 'ELEVENLABS',
    "defaultVoiceId" TEXT,
    "defaultVisibility" "PublishVisibility" NOT NULL DEFAULT 'PRIVATE',
    "defaultTags" TEXT[],
    "storageBucket" TEXT,
    "defaultScriptPromptId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "user_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "channel_userId_deletedAt_idx" ON "channel"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "channel_userId_youtubeChannelId_key" ON "channel"("userId", "youtubeChannelId");

-- CreateIndex
CREATE INDEX "channel_statistic_channelId_capturedAt_idx" ON "channel_statistic"("channelId", "capturedAt");

-- CreateIndex
CREATE INDEX "project_userId_status_deletedAt_idx" ON "project"("userId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "video_userId_status_deletedAt_idx" ON "video"("userId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "video_projectId_deletedAt_idx" ON "video"("projectId", "deletedAt");

-- CreateIndex
CREATE INDEX "video_createdAt_idx" ON "video"("createdAt");

-- CreateIndex
CREATE INDEX "video_status_event_videoId_createdAt_idx" ON "video_status_event"("videoId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "script_activeVersionId_key" ON "script"("activeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "script_videoId_key" ON "script"("videoId");

-- CreateIndex
CREATE INDEX "script_version_scriptId_createdAt_idx" ON "script_version"("scriptId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "script_version_scriptId_version_key" ON "script_version"("scriptId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "voice_over_videoId_key" ON "voice_over"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "thumbnail_activeVersionId_key" ON "thumbnail"("activeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "thumbnail_videoId_key" ON "thumbnail"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "thumbnail_version_thumbnailId_version_key" ON "thumbnail_version"("thumbnailId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scene_videoId_index_key" ON "scene"("videoId", "index");

-- CreateIndex
CREATE INDEX "asset_sceneId_kind_idx" ON "asset"("sceneId", "kind");

-- CreateIndex
CREATE INDEX "render_job_videoId_createdAt_idx" ON "render_job"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "render_job_status_idx" ON "render_job"("status");

-- CreateIndex
CREATE INDEX "render_log_renderJobId_createdAt_idx" ON "render_log"("renderJobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "publication_videoId_key" ON "publication"("videoId");

-- CreateIndex
CREATE INDEX "publication_channelId_status_idx" ON "publication"("channelId", "status");

-- CreateIndex
CREATE INDEX "publication_scheduledFor_idx" ON "publication"("scheduledFor");

-- CreateIndex
CREATE INDEX "video_analytic_capturedFor_idx" ON "video_analytic"("capturedFor");

-- CreateIndex
CREATE UNIQUE INDEX "video_analytic_publicationId_capturedFor_key" ON "video_analytic"("publicationId", "capturedFor");

-- CreateIndex
CREATE INDEX "prompt_template_userId_category_deletedAt_idx" ON "prompt_template"("userId", "category", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_template_userId_name_key" ON "prompt_template"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_variable_promptTemplateId_key_key" ON "prompt_variable"("promptTemplateId", "key");

-- CreateIndex
CREATE INDEX "provider_credential_userId_deletedAt_idx" ON "provider_credential"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credential_userId_provider_key" ON "provider_credential"("userId", "provider");

-- CreateIndex
CREATE INDEX "provider_usage_provider_createdAt_idx" ON "provider_usage"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "provider_usage_credentialId_createdAt_idx" ON "provider_usage"("credentialId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_log_userId_createdAt_idx" ON "activity_log"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_log_entityType_entityId_idx" ON "activity_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "activity_log_level_createdAt_idx" ON "activity_log"("level", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_setting_userId_key" ON "user_setting"("userId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel" ADD CONSTRAINT "channel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_statistic" ADD CONSTRAINT "channel_statistic_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video" ADD CONSTRAINT "video_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video" ADD CONSTRAINT "video_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_status_event" ADD CONSTRAINT "video_status_event_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "script" ADD CONSTRAINT "script_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "script" ADD CONSTRAINT "script_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "script_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "script_version" ADD CONSTRAINT "script_version_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "script"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_over" ADD CONSTRAINT "voice_over_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thumbnail" ADD CONSTRAINT "thumbnail_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thumbnail" ADD CONSTRAINT "thumbnail_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "thumbnail_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thumbnail_version" ADD CONSTRAINT "thumbnail_version_thumbnailId_fkey" FOREIGN KEY ("thumbnailId") REFERENCES "thumbnail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "scene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_job" ADD CONSTRAINT "render_job_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_log" ADD CONSTRAINT "render_log_renderJobId_fkey" FOREIGN KEY ("renderJobId") REFERENCES "render_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication" ADD CONSTRAINT "publication_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication" ADD CONSTRAINT "publication_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_analytic" ADD CONSTRAINT "video_analytic_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_variable" ADD CONSTRAINT "prompt_variable_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "prompt_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "provider_credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_setting" ADD CONSTRAINT "user_setting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
