import type { AiProviderType } from "@/generated/prisma/enums";

/** Display names for the operator-facing provider table — the enum values themselves are wire identifiers, not copy. */
export const PROVIDER_LABELS: Record<AiProviderType, string> = {
  OPENAI: "OpenAI",
  ANTHROPIC: "Anthropic",
  GEMINI: "Gemini",
  ELEVENLABS: "ElevenLabs",
  GOOGLE_VEO: "Google Veo",
  RUNWAY: "Runway",
  KLING: "Kling",
  REPLICATE: "Replicate",
  PIKA: "Pika",
  LUMA: "Luma",
  FAL: "fal.ai",
  JAMENDO: "Jamendo",
  PEXELS: "Pexels",
  PIXABAY: "Pixabay",
};
