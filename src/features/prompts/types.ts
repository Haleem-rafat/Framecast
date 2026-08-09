import type { promptTemplateService } from "@/services/prompt-template.service";

/** Derived from the service return type so the UI can never drift from what `list()` actually selects. */
export type PromptTemplateWithVariables = Awaited<
  ReturnType<typeof promptTemplateService.list>
>[number];
