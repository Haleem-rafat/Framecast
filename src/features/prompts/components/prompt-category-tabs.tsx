import { Library, Plus } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PromptTemplateDialog } from "@/features/prompts/components/prompt-template-dialog";
import { PromptTemplateTable } from "@/features/prompts/components/prompt-template-table";
import { PROMPT_CATEGORY_LABELS } from "@/features/prompts/prompt-category-labels";
import type { PromptTemplateWithVariables } from "@/features/prompts/types";
import { promptCategories } from "@/schemas/prompt.schema";

export function PromptCategoryTabs({
  templates,
}: {
  templates: PromptTemplateWithVariables[];
}) {
  return (
    <Tabs defaultValue={promptCategories[0]}>
      {/* Six categories come to roughly 460px of tabs. Without this the strip
       * was the widest thing on the page at 375px, so the whole document
       * scrolled sideways to accommodate it. Scrolling the strip instead keeps
       * every category reachable and the page itself still. The negative
       * margin lets it run to the screen edge, which is the cue that there is
       * more of it off to the right. */}
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
        <TabsList>
          {promptCategories.map((category) => (
            <TabsTrigger key={category} value={category}>
              {PROMPT_CATEGORY_LABELS[category]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {promptCategories.map((category) => {
        const inCategory = templates.filter((one) => one.category === category);

        return (
          <TabsContent key={category} value={category} className="space-y-4">
            <div className="flex items-center justify-end">
              <PromptTemplateDialog
                category={category}
                trigger={
                  <Button size="sm">
                    <Plus />
                    New template
                  </Button>
                }
              />
            </div>

            {inCategory.length === 0 ? (
              <EmptyState
                icon={Library}
                title={`No ${PROMPT_CATEGORY_LABELS[category].toLowerCase()} templates`}
                // Was "Create one to control how this content is generated",
                // which is an instruction with no mechanism attached — it never
                // said which of two buttons on the screen does it, nor that
                // having a template is not the same as using one.
                description="“New template” just above adds one. Mark a template as the default and it becomes the one this category generates from."
              />
            ) : (
              <PromptTemplateTable
                templates={inCategory}
                categoryLabel={PROMPT_CATEGORY_LABELS[category]}
              />
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
