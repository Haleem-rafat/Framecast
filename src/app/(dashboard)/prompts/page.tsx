import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { PromptCategoryTabs } from "@/features/prompts/components/prompt-category-tabs";
import { ScriptStyleBrowser } from "@/features/prompts/components/script-style-browser";
import { SCRIPT_STYLES } from "@/lib/script-styles";
import { promptTemplateService } from "@/services/prompt-template.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Prompt Library" };

export default async function PromptsPage() {
  const user = await requireUser();

  // Both scoped to this operator. `listOwnedScriptStyleIds` is one indexed
  // lookup by name, and it is what lets the browse dialog say "in your
  // library" rather than offering an add the service would refuse.
  const [templates, ownedStyleIds] = await Promise.all([
    promptTemplateService.list(user.id),
    promptTemplateService.listOwnedScriptStyleIds(user.id, SCRIPT_STYLES),
  ]);

  return (
    <>
      <PageHeader
        title="Prompt Library"
        description="Templates used to generate scripts, thumbnails, scenes, and metadata."
        actions={<ScriptStyleBrowser ownedStyleIds={ownedStyleIds} />}
      />

      <Reveal>
        <PromptCategoryTabs templates={templates} />
      </Reveal>
    </>
  );
}
