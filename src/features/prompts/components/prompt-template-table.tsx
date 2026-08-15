"use client";

import { useMemo } from "react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { BulkDeletePromptsButton } from "@/features/prompts/components/bulk-delete-prompts-button";
import { PromptTemplateActions } from "@/features/prompts/components/prompt-template-actions";
import type { PromptTemplateWithVariables } from "@/features/prompts/types";

/**
 * One category's templates.
 *
 * A `DataTable` rather than the grid of cards this page used to be, so the
 * library inherits multi-select — and the search and sort — from the same
 * component every other list in the app uses, instead of growing a second
 * selection implementation of its own. Below `md` the table renders as cards
 * anyway, which is close to what was here before.
 *
 * Rendered once per tab, so each category keeps its own selection: Radix
 * unmounts an inactive tab's content, and a selection that survived a tab
 * switch would be a set of rows the operator can no longer see.
 */
export function PromptTemplateTable({
  templates,
  categoryLabel,
}: {
  templates: PromptTemplateWithVariables[];
  categoryLabel: string;
}) {
  const columns = useMemo<DataTableColumn<PromptTemplateWithVariables>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: (template) => (
          <div className="max-w-[24rem]" title={template.name}>
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{template.name}</span>
              {template.isDefault && <Badge>Default</Badge>}
            </div>
            {template.description && (
              <p className="text-muted-foreground truncate text-xs">
                {template.description}
              </p>
            )}
          </div>
        ),
        sortValue: (template) => template.name,
        filterValue: (template) =>
          `${template.name} ${template.description ?? ""}`,
        alwaysVisible: true,
      },
      {
        id: "variables",
        header: "Variables",
        cell: (template) =>
          template.variables.length > 0 ? (
            <div className="flex max-w-[20rem] flex-wrap gap-1.5">
              {template.variables.map((variable) => (
                <Badge
                  key={variable.id}
                  variant="outline"
                  className="font-mono"
                >
                  {variable.key}
                  {variable.required && "*"}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">None</span>
          ),
        // By count, not by name: "which of these takes the most filling in"
        // is the only ordering question a bag of badges can answer.
        sortValue: (template) => template.variables.length,
        filterValue: (template) =>
          template.variables.map((variable) => variable.key).join(" "),
        firstSortDirection: "desc",
      },
      {
        id: "updatedAt",
        header: "Updated",
        cell: (template) => <RelativeTime date={template.updatedAt} />,
        sortValue: (template) => template.updatedAt,
        firstSortDirection: "desc",
        cellClassName: "text-muted-foreground text-sm",
      },
      {
        id: "actions",
        header: "Actions",
        cell: (template) => <PromptTemplateActions template={template} />,
        align: "right",
        alwaysVisible: true,
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={templates}
      columns={columns}
      getRowId={(template) => template.id}
      caption={`${categoryLabel} templates`}
      searchPlaceholder={`Search ${categoryLabel.toLowerCase()} templates`}
      pageSize={25}
      selection={{
        rowLabel: (template) => template.name,
        actions: ({ rows, clear }) => (
          <BulkDeletePromptsButton templates={rows} onDone={clear} />
        ),
      }}
    />
  );
}
