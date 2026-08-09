import { z } from "zod";

export const promptCategories = [
  "SCRIPT",
  "THUMBNAIL",
  "SCENE",
  "TITLE",
  "DESCRIPTION",
  "TAGS",
] as const;

export const promptVariableSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and _ only"),
  label: z.string().min(1).max(60),
  defaultValue: z.string().max(200).optional(),
  required: z.boolean().default(false),
});

export const upsertPromptSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  category: z.enum(promptCategories),
  content: z.string().min(10, "A prompt needs more than a few words"),
  isDefault: z.boolean().default(false),
  variables: z.array(promptVariableSchema).max(20),
});

export type UpsertPromptInput = z.infer<typeof upsertPromptSchema>;
