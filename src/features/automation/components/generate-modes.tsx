"use client";

import { useState } from "react";
import { PenLine, Zap } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AutomationFlow } from "@/features/automation/components/automation-flow";
import { EasyModeFlow } from "@/features/automation/components/easy-mode-flow";
import type {
  AutomationProject,
  AutomationPromptSummary,
} from "@/services/automation.service";
import type { EasyChannel } from "@/services/easy-mode.service";

type Mode = "easy" | "written";

/**
 * The two ways to make one video, on one page and one URL.
 *
 * ## Why a mode and not a replacement
 *
 * Easy mode answers every question from the channel, which is right for the
 * operator who wants a video for their channel this afternoon and wrong for the
 * one who has a specific subject and a specific length in mind. Both are real
 * and neither is a fallback for the other, so the written form keeps every
 * capability it had — a typed topic, a value per prompt variable, a chosen
 * duration — and loses nothing at all to this change.
 *
 * Easy mode is the default because it is the common case, and because it is
 * recoverable: an operator who lands on it and wants the long form is one tap
 * away, whereas an operator who lands on four text boxes has already been asked
 * to do the work.
 *
 * ## Why the mode lives in state and not in the URL
 *
 * `/automation/generate` is the sidebar entry, the ⌘K entry, the mobile dock
 * entry and the destination of "Make one now" from a series, and
 * `?video=<id>` on the same route is a run in progress. Adding a second query
 * parameter for the mode would put a second meaning on an address that already
 * carries one, and would make the nav's active-state matching answer questions
 * it should not have to. The switch is a tab because a tab is what it is.
 */
export function GenerateModes({
  channels,
  projects,
  prompt,
}: {
  channels: EasyChannel[];
  projects: AutomationProject[];
  prompt: AutomationPromptSummary;
}) {
  const [mode, setMode] = useState<Mode>("easy");

  return (
    <Tabs value={mode} onValueChange={(next) => setMode(next as Mode)}>
      {/* The strip bleeds to the screen edge on a phone rather than making the
          document scroll sideways — the same treatment `prompt-category-tabs`
          uses, for the same reason. */}
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
        <TabsList>
          <TabsTrigger value="easy">
            <Zap data-icon="inline-start" />
            Easy mode
          </TabsTrigger>
          <TabsTrigger value="written">
            <PenLine data-icon="inline-start" />
            Write it myself
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="easy">
        <EasyModeFlow
          channels={channels}
          promptName={prompt.name}
          onWriteItMyself={() => setMode("written")}
        />
      </TabsContent>

      <TabsContent value="written">
        <AutomationFlow projects={projects} prompt={prompt} />
      </TabsContent>
    </Tabs>
  );
}
