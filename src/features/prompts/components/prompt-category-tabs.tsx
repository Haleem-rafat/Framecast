import { Library, Plus } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PromptTemplateCard } from "@/features/prompts/components/prompt-template-card";
import { PromptTemplateDialog } from "@/features/prompts/components/prompt-template-dialog";
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
      <TabsList>
        {promptCategories.map((category) => (
          <TabsTrigger key={category} value={category}>
            {PROMPT_CATEGORY_LABELS[category]}
          </TabsTrigger>
        ))}
      </TabsList>

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
                description="Create one to control how this content is generated."
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {inCategory.map((template) => (
                  <PromptTemplateCard key={template.id} template={template} />
                ))}
              </div>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
