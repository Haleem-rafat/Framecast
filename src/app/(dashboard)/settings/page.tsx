import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { RelativeTime } from "@/components/shared/relative-time";
import { GuidesCard } from "@/features/onboarding/components/guides-card";
import { SettingsForm } from "@/features/settings/components/settings-form";
import { settingsService } from "@/services/settings.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();
  const settings = await settingsService.get(user.id);

  return (
    <>
      <PageHeader
        title="Settings"
        description="How the studio looks to you, and how your videos reach YouTube."
      />

      <SettingsForm settings={settings} />

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
