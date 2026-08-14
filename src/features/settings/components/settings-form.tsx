"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
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
import { FormField, FormFieldset } from "@/components/shared/form-field";
import { Reveal } from "@/components/shared/reveal";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccentPicker } from "@/features/settings/components/accent-picker";
import { AccentPreview } from "@/features/settings/components/accent-preview";
import { previewAccent } from "@/features/settings/components/appearance-preview";
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

/**
 * The stored enum as next-themes names it. next-themes is the thing that
 * actually flips the class on `<html>`, so previewing a theme means speaking
 * its vocabulary rather than inventing a parallel one.
 */
const NEXT_THEMES_NAME: Record<(typeof themePreferences)[number], string> = {
  LIGHT: "light",
  DARK: "dark",
  SYSTEM: "system",
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
 *
 * A function returning content rather than a component rendering its own `<p>`,
 * because it is passed to `FormField`'s `note` slot — which owns the element,
 * the id and the `aria-describedby` link back to the control. It used to be a
 * private re-implementation of `FieldDescription` at a different size.
 */
function wiringNote(setting: SettingKey): ReactNode {
  const wiring = SETTING_WIRING[setting];

  if (wiring.applied) {
    return null;
  }

  return (
    <>
      <span className="text-foreground/70 font-medium">Not used yet.</span>{" "}
      {wiring.actualSource}
    </>
  );
}

function toDefaultValues(settings: UserSettingsView): SettingsFormValues {
  return {
    theme: settings.theme,
    accent: settings.accent,
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

  const { setTheme } = useTheme();
  const accent = useWatch({ control, name: "accent" });
  const theme = useWatch({ control, name: "theme" });

  /**
   * Whatever is currently *persisted*, as opposed to whatever the form is
   * showing. Held in a ref rather than read from the `settings` prop inside the
   * cleanup below, because an effect cleanup closes over the render it was
   * scheduled in — after a save, `router.refresh()` gives this component new
   * props, and a cleanup holding the pre-save values would "restore" the studio
   * to an appearance the operator has already replaced.
   */
  const persisted = useRef(settings);
  persisted.current = settings;

  /**
   * The preview.
   *
   * Appearance is the one group of settings whose effect is the page you are
   * looking at, so the honest preview is the studio itself: click a swatch and
   * the sidebar, the buttons and the focus rings all change, which is both a
   * better answer than a thumbnail and impossible to get wrong, because it goes
   * through the same `accentStyleSheet()` the server used.
   *
   * The cleanup is what keeps that from being a lie in the other direction. An
   * operator who previews Plum and then navigates away without saving must not
   * be left in a studio that is Plum until the next full page load, so unmount
   * puts back whatever is actually stored. After a successful save those are
   * the same value and the restore is a no-op.
   */
  useEffect(() => {
    previewAccent(accent);

    return () => previewAccent(persisted.current.accent);
  }, [accent]);

  useEffect(() => {
    setTheme(NEXT_THEMES_NAME[theme]);

    return () => setTheme(NEXT_THEMES_NAME[persisted.current.theme]);
  }, [theme, setTheme]);

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
          <CardDescription>
            How the studio looks to you. Both settings are yours alone — they
            follow your account to any browser you sign in from, and change
            nothing for anyone else.
          </CardDescription>
        </CardHeader>
        {/* `FieldGroup` rather than a per-card `space-y-*`: the four cards were
            using five different spacing scales between them, so the rhythm of
            the page changed depending which card you were looking at. */}
        <CardContent>
          <FieldGroup>
            <Controller
              control={control}
              name="theme"
              render={({ field }) => (
                <FormField
                  name="theme"
                  label="Theme"
                  note={wiringNote("theme")}
                >
                  {(controlProps) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger
                        {...controlProps}
                        className="w-full sm:w-64"
                      >
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
                </FormField>
              )}
            />

            {/* A fieldset, not a field: the control is a radio group whose
                accessible name comes from its own <legend>, so there is no
                single element for a <label> to point at. This used to be a
                hand-built heading out of two <p>s. */}
            <FormFieldset
              label="Accent colour"
              description="Used for buttons, links, focus rings and the active sidebar item. Graphite is the studio's original monochrome."
              note={wiringNote("accent")}
            >
              <Controller
                control={control}
                name="accent"
                render={({ field }) => (
                  <AccentPicker value={field.value} onChange={field.onChange} />
                )}
              />

              <AccentPreview />
            </FormFieldset>
          </FieldGroup>
        </CardContent>
      </Card>

      {/* Appearance stays put — it is the card the operator can see on arrival,
       * and the one whose controls change the page around them. The three below
       * it are off screen on every viewport this form has been checked at, so
       * they fade up as they are reached. Tabbing into one counts as reaching
       * it: the browser scrolls a focused field into view, which is the same
       * crossing the observer is watching for. */}
      <Reveal>
        <Card>
          <CardHeader>
            <CardTitle>Generation defaults</CardTitle>
            <CardDescription>
              Which model writes the script and which voice reads it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <div className="grid gap-5 sm:grid-cols-2">
                <Controller
                  control={control}
                  name="defaultScriptProvider"
                  render={({ field }) => (
                    <FormField
                      name="defaultScriptProvider"
                      label="Script provider"
                      note={wiringNote("defaultScriptProvider")}
                    >
                      {(controlProps) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger {...controlProps} className="w-full">
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
                    </FormField>
                  )}
                />

                <Controller
                  control={control}
                  name="defaultVoiceProvider"
                  render={({ field }) => (
                    <FormField
                      name="defaultVoiceProvider"
                      label="Voice provider"
                      note={wiringNote("defaultVoiceProvider")}
                    >
                      {(controlProps) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger {...controlProps} className="w-full">
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
                    </FormField>
                  )}
                />
              </div>

              <FormField
                name="defaultVoiceId"
                label="Voice ID"
                error={errors.defaultVoiceId?.message}
                note={wiringNote("defaultVoiceId")}
              >
                {(controlProps) => (
                  <Input
                    placeholder="CwhRBWXzGAHq8TQ4Fs17"
                    className="font-mono sm:max-w-sm"
                    {...register("defaultVoiceId")}
                    {...controlProps}
                  />
                )}
              </FormField>

              <Controller
                control={control}
                name="defaultScriptPromptId"
                render={({ field }) => (
                  <FormField
                    name="defaultScriptPromptId"
                    label="Script template"
                    note={wiringNote("defaultScriptPromptId")}
                  >
                    {(controlProps) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger
                          {...controlProps}
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
                  </FormField>
                )}
              />
            </FieldGroup>
          </CardContent>
        </Card>
      </Reveal>

      <Reveal>
        <Card>
          <CardHeader>
            <CardTitle>Publishing defaults</CardTitle>
            <CardDescription>
              How a finished video reaches YouTube.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Controller
                control={control}
                name="defaultVisibility"
                render={({ field }) => (
                  <FormField
                    name="defaultVisibility"
                    label="Visibility"
                    note={wiringNote("defaultVisibility")}
                  >
                    {(controlProps) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger
                          {...controlProps}
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
                  </FormField>
                )}
              />

              {/* The hint and the error share one slot, so the card does not grow
                  a line taller the moment a tag list is rejected. */}
              <FormField
                name="defaultTags"
                label="Tags"
                description={`Comma separated, up to ${MAX_DEFAULT_TAGS}.`}
                error={errors.defaultTags?.message}
                note={wiringNote("defaultTags")}
              >
                {(controlProps) => (
                  <Input
                    placeholder="finance, explainer, market news"
                    {...register("defaultTags")}
                    {...controlProps}
                  />
                )}
              </FormField>
            </FieldGroup>
          </CardContent>
        </Card>
      </Reveal>

      <Reveal>
        <Card>
          <CardHeader>
            <CardTitle>Storage</CardTitle>
            <CardDescription>Where rendered files are kept.</CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              name="storageBucket"
              label="Bucket"
              error={errors.storageBucket?.message}
              note={wiringNote("storageBucket")}
            >
              {(controlProps) => (
                <Input
                  className="font-mono sm:max-w-sm"
                  {...register("storageBucket")}
                  {...controlProps}
                />
              )}
            </FormField>
          </CardContent>
        </Card>
      </Reveal>

      {/* Stacked and full-width on a phone, inline on a desktop — the primary
          action of a long form is the last thing that should be a 110px target
          at the bottom of a 375px screen.
          Stacked in DOM order rather than reversed: `flex-col-reverse` would
          have put Save under Discard visually while leaving it first in the tab
          order, which is the focus-order trap that reads fine to a mouse and
          wrong to a keyboard. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
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
