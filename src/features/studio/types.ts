/**
 * Re-exported so client components can be typed against what the services
 * return without importing the services themselves — every one of them is
 * `server-only`, and a value import from a client component is a build error.
 * `import type` is erased before that can happen. Same arrangement as
 * `src/features/videos/types.ts`.
 */
export type {
  NarrationEntry,
  ScriptLibraryEntry,
  ScriptVersionContent,
  ThumbnailEntry,
  ThumbnailVersionEntry,
  VoiceAllowance,
} from "@/services/studio.service";

export type {
  PublicationEntry,
  ReadyVideoEntry,
} from "@/services/publishing.service";
