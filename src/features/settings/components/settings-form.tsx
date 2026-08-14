"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { updateSettingsAction } from "@/actions/settings.action";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SETTING_WIRING,
  type SettingKey,
} from "@/features/settings/setting-wiring";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";
import {
  MAX_DEFAULT_TAGS,
  NO_SCRIPT_PROMPT,
  publishVisibilities,
  scriptProviderOptions,
  settingsFormSchema,
  themePreferences,
  voiceProviderOptions,
  type SettingsFormValues,
  type UpdateSettingsInput,
} from "@/schemas/settings.schema";
import type { UserSettingsView } from "@/services/settings.service";

const THEME_LABELS: Record<(typeof themePreferences)[number], string> = {
  LIGHT: "Light",
  DARK: "Dark",
  SYSTEM: "Match the system",
};

const VISIBILITY_LABELS: Record<(typeof publishVisibilities)[number], string> = {
  PUBLIC: "Public",
  UNLISTED: "Unlisted",
  PRIVATE: "Private",
};

export interface ScriptPromptOption {
  id: string;
  name: string;
}

interface SettingsFormProps {
  settings: UserSettingsView;
  /** The operator's own SCRIPT templates — the only valid pins for this field. */
  scriptPrompts: ScriptPromptOption[];
}

/**
 * The disclosure that sits under an unwired control. Rendered as ordinary help
 * text rather than a warning: the operator did nothing wrong, and there is
 * nothing for them to fix — it just says where the value really comes from.
 */
function WiringNote({ setting }: { setting: SettingKey }) {
  const wiring = SETTING_WIRING[setting];

  if (wiring.applied) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs">
      <span className="text-foreground/70 font-medium">Not used yet.</span>{" "}
      {wiring.actualSource}
    </p>
  );
}

function toDefaultValues(settings: UserSettingsView): SettingsFormValues {
  return {
    theme: settings.theme,
    // The column is typed as the full provider enum but the form offers a
    // narrowed list, so a value saved before that list existed (or seeded
    // directly) may not be one of the options. Falling back keeps the select
    // from rendering blank and silently rewriting the field on save.
    defaultScriptProvider: isScriptProvider(settings.defaultScriptProvider)
      ? settings.defaultScriptProvider
      : "ANTHROPIC",
    defaultVoiceProvider: isVoiceProvider(settings.defaultVoiceProvider)
      ? settings.defaultVoiceProvider
      : "ELEVENLABS",
    defaultVoiceId: settings.defaultVoiceId ?? "",
    defaultVisibility: settings.defaultVisibility,
    defaultTags: settings.defaultTags.join(", "),
    storageBucket: settings.storageBucket ?? "",
    defaultScriptPromptId: settings.defaultScriptPromptId ?? NO_SCRIPT_PROMPT,
  };
}

function isScriptProvider(
  value: string,
): value is (typeof scriptProviderOptions)[number] {
  return (scriptProviderOptions as readonly string[]).includes(value);
}

function isVoiceProvider(
  value: string,
): value is (typeof voiceProviderOptions)[number] {
  return (voiceProviderOptions as readonly string[]).includes(value);
}

export function SettingsForm({ settings, scriptPrompts }: SettingsFormProps) {
  const router = useRouter();

  // `defaultTags` is a comma-separated string in the form and a `string[]`
  // after parsing, so the zod input and output types differ. RHF's
  // three-generic `useForm` bridges them — same arrangement as the prompt
  // template dialog.
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<SettingsFormValues, unknown, UpdateSettingsInput>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: toDefaultValues(settings),
  });

  async function onSubmit(values: UpdateSettingsInput) {
    const result = await updateSettingsAction(values);

    if (!result.ok) {
      toast.error("Could not save your settings", {
        description: result.error.message,
      });
      return;
    }

    toast.success("Settings saved");
    // Keeps what is on screen but clears `isDirty`, so the Save button goes
    // back to disabled. Without this the form would still look unsaved after a
    // successful save, since `router.refresh()` re-renders the server tree but
    // does not remount this component or re-run `defaultValues`.
    reset(undefined, { keepValues: true });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>How the studio looks to you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="theme">Theme</Label>
          <Controller
            control={control}
            name="theme"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="theme" className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {themePreferences.map((one) => (
                    <SelectItem key={one} value={one}>
                      {THEME_LABELS[one]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <WiringNote setting="theme" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Generation defaults</CardTitle>
          <CardDescription>
            Which model writes the script and which voice reads it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="defaultScriptProvider">Script provider</Label>
              <Controller
                control={control}
                name="defaultScriptProvider"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="defaultScriptProvider"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scriptProviderOptions.map((one) => (
                        <SelectItem key={one} value={one}>
                          {PROVIDER_LABELS[one]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <WiringNote setting="defaultScriptProvider" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="defaultVoiceProvider">Voice provider</Label>
              <Controller
                control={control}
                name="defaultVoiceProvider"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="defaultVoiceProvider" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {voiceProviderOptions.map((one) => (
                        <SelectItem key={one} value={one}>
                          {PROVIDER_LABELS[one]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <WiringNote setting="defaultVoiceProvider" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="defaultVoiceId">Voice ID</Label>
            <Input
              id="defaultVoiceId"
              placeholder="CwhRBWXzGAHq8TQ4Fs17"
              className="font-mono sm:max-w-sm"
              aria-invalid={Boolean(errors.defaultVoiceId)}
              {...register("defaultVoiceId")}
            />
            {errors.defaultVoiceId && (
              <p className="text-destructive text-xs">
                {errors.defaultVoiceId.message}
              </p>
            )}
            <WiringNote setting="defaultVoiceId" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="defaultScriptPromptId">Script template</Label>
            <Controller
              control={control}
              name="defaultScriptPromptId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    id="defaultScriptPromptId"
                    className="w-full sm:max-w-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SCRIPT_PROMPT}>
                      No template pinned
                    </SelectItem>
                    {scriptPrompts.map((prompt) => (
                      <SelectItem key={prompt.id} value={prompt.id}>
                        {prompt.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <WiringNote setting="defaultScriptPromptId" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publishing defaults</CardTitle>
          <CardDescription>
            How a finished video reaches YouTube.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="defaultVisibility">Visibility</Label>
            <Controller
              control={control}
              name="defaultVisibility"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    id="defaultVisibility"
                    className="w-full sm:w-64"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {publishVisibilities.map((one) => (
                      <SelectItem key={one} value={one}>
                        {VISIBILITY_LABELS[one]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <WiringNote setting="defaultVisibility" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="defaultTags">Tags</Label>
            <Input
              id="defaultTags"
              placeholder="finance, explainer, market news"
              aria-invalid={Boolean(errors.defaultTags)}
              {...register("defaultTags")}
            />
            {errors.defaultTags ? (
              <p className="text-destructive text-xs">
                {errors.defaultTags.message}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Comma separated, up to {MAX_DEFAULT_TAGS}.
              </p>
            )}
            <WiringNote setting="defaultTags" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>Where rendered files are kept.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="storageBucket">Bucket</Label>
          <Input
            id="storageBucket"
            className="font-mono sm:max-w-sm"
            aria-invalid={Boolean(errors.storageBucket)}
            {...register("storageBucket")}
          />
          {errors.storageBucket && (
            <p className="text-destructive text-xs">
              {errors.storageBucket.message}
            </p>
          )}
          <WiringNote setting="storageBucket" />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Save settings
        </Button>
        {isDirty && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => reset(toDefaultValues(settings))}
          >
            Discard changes
          </Button>
        )}
      </div>
    </form>
  );
}
