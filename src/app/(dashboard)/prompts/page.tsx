import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { PromptCategoryTabs } from "@/features/prompts/components/prompt-category-tabs";
import { promptTemplateService } from "@/services/prompt-template.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Prompt Library" };

export default async function PromptsPage() {
  const user = await requireUser();
  const templates = await promptTemplateService.list(user.id);

  return (
    <>
      <PageHeader
        title="Prompt Library"
        description="Templates used to generate scripts, thumbnails, scenes, and metadata."
      />

      <PromptCategoryTabs templates={templates} />
    </>
  );
}
