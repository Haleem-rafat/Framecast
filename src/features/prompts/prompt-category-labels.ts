import type { PromptCategory } from "@/generated/prisma/enums";

export const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  SCRIPT: "Script",
  THUMBNAIL: "Thumbnail",
  SCENE: "Scene",
  TITLE: "Title",
  DESCRIPTION: "Description",
  TAGS: "Tags",
};
