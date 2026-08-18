import { z } from "zod";

export const aiProviderTypes = [
  "OPENAI",
  "ANTHROPIC",
  "GEMINI",
  "ELEVENLABS",
  "GOOGLE_VEO",
  "RUNWAY",
  "KLING",
  "REPLICATE",
  "PIKA",
  "LUMA",
  "FAL",
] as const;

export const upsertCredentialSchema = z.object({
  provider: z.enum(aiProviderTypes),
  apiKey: z.string().min(8, "That key looks too short to be valid"),
  label: z.string().max(60).optional(),
});

export type UpsertCredentialInput = z.infer<typeof upsertCredentialSchema>;
