import type { Metadata } from "next";
import { Info } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { RelativeTime } from "@/components/shared/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { GuidesCard } from "@/features/onboarding/components/guides-card";
import { SettingsForm } from "@/features/settings/components/settings-form";
import {
  TOTAL_SETTING_COUNT,
  UNAPPLIED_SETTING_COUNT,
} from "@/features/settings/setting-wiring";
import { promptTemplateService } from "@/services/prompt-template.service";
import { settingsService } from "@/services/settings.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();

  const [settings, templates] = await Promise.all([
    settingsService.get(user.id),
    promptTemplateService.list(user.id),
  ]);

  // Only SCRIPT templates can be pinned as the script template, and only this
  // operator's own — the service re-checks ownership on save, but the dropdown
  // should never have offered someone else's in the first place.
  const scriptPrompts = templates
    .filter((template) => template.category === "SCRIPT")
    .map((template) => ({ id: template.id, name: template.name }));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your defaults for generation, publishing and storage."
      />

      {UNAPPLIED_SETTING_COUNT > 0 && (
        <Alert>
          <Info />
          <AlertTitle>
            {UNAPPLIED_SETTING_COUNT === TOTAL_SETTING_COUNT
              ? "These preferences are saved, but nothing reads them yet"
              : `${UNAPPLIED_SETTING_COUNT} of these preferences are saved, but nothing reads them yet`}
          </AlertTitle>
          <AlertDescription>
            <p>
              The pipeline still takes each of these values from somewhere else
              — an environment variable, a fixed choice in the code, or a
              per-video field. Saving here records your preference for when
              those are wired up; it does not change what the next video does.
              Each field below says where its value actually comes from today.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <SettingsForm settings={settings} scriptPrompts={scriptPrompts} />

      {/* Below the form rather than in it. Nothing here is a saved preference —
       * these three buttons take effect the moment they are pressed and there
       * is nothing to submit — so putting them inside a form whose Save button
       * would not apply to them would be the misleading arrangement. This is
       * also the answer to "I closed the thing that explained the product":
       * /settings is reachable from the sidebar, the account menu and the
       * phone dock's More sheet, so onboarding is findable again from every
       * navigation surface without any of them growing a new control. */}
      <GuidesCard />

      <p className="text-muted-foreground text-xs">
        {settings.updatedAt ? (
          <>
            Last saved <RelativeTime date={settings.updatedAt} />.
          </>
        ) : (
          "Never saved — the values above are the defaults."
        )}
      </p>
    </>
  );
}
