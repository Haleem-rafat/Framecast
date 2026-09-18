"use client";

import Link from "next/link";
import { Layers, MonitorPlay, Plus, Sparkles } from "lucide-react";

import { FormField } from "@/components/shared/form-field";
import { ChoiceCard, ChoiceGroup } from "@/components/shared/wizard/choice-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { VideoFormat } from "@/generated/prisma/enums";
import { VIDEO_FORMATS } from "@/lib/video-format";
import type { AutomationField } from "@/services/automation.service";

import { findNichePreset, NICHE_PRESETS, type NichePreset } from "./niche-presets";
import {
  declaredFields,
  parseTopics,
  projectsFor,
  type SeriesDraft,
  type WizardContext,
} from "./series-wizard-state";

/** What every step component is handed. `update` takes a function so a step
 *  can never write from a stale copy of the draft. */
export interface StepProps {
  draft: SeriesDraft;
  update: (next: (draft: SeriesDraft) => SeriesDraft) => void;
  context: WizardContext;
  /** The step heading's id, so its choice group can be labelled by it. */
  headingId: string;
}

/**
 * Step 1: what the show is about.
 *
 * Presets are the fast path; Custom is the honest one — a niche this list does
 * not name is just "pick the script style that writes it", so that is what the
 * tab offers rather than a free-text box nothing downstream would read.
 */
export function NicheStep({
  draft,
  update,
  context,
  headingId,
  onApplyPreset,
  onChooseStyle,
}: StepProps & {
  onApplyPreset: (preset: NichePreset) => void;
  onChooseStyle: (promptTemplateId: string) => void;
}) {
  const preset = findNichePreset(draft.nichePresetId);
  const style = context.setup.scriptStyles.find((entry) => entry.id === draft.promptTemplateId);

  return (
    <Tabs defaultValue={draft.nichePresetId === "custom" ? "custom" : "presets"}>
      <TabsList variant="line" className="border-b">
        <TabsTrigger value="presets">
          <Layers />
          Presets
        </TabsTrigger>
        <TabsTrigger value="custom">
          <Sparkles />
          Custom
        </TabsTrigger>
      </TabsList>

      <TabsContent value="presets" className="space-y-3 pt-3">
        <ChoiceGroup
          name="niche-preset"
          value={preset?.id ?? null}
          onChange={(id) => {
            const next = findNichePreset(id);
            if (next) onApplyPreset(next);
          }}
          labelledBy={headingId}
        >
          {NICHE_PRESETS.map((entry) => (
            <ChoiceCard key={entry.id} value={entry.id} title={entry.title} description={entry.description} />
          ))}
        </ChoiceGroup>

        {preset && style && (
          <p className="text-muted-foreground text-xs">
            Episodes are written with your &ldquo;{style.name}&rdquo; script style. You
            can edit the name and the starter topics on the next step, or pick a
            different style under Custom.
          </p>
        )}
      </TabsContent>

      <TabsContent value="custom" className="space-y-3 pt-3">
        <p className="text-muted-foreground text-xs">
          Any script style in your{" "}
          <Link href="/prompts" className="text-primary underline-offset-4 hover:underline">
            prompt library
          </Link>
          . You write the name and topics yourself on the next step.
        </p>
        <ChoiceGroup
          name="script-style"
          value={draft.nichePresetId === "custom" ? draft.promptTemplateId : null}
          onChange={(id) => {
            onChooseStyle(id);
            update((current) => ({ ...current, nichePresetId: "custom" }));
          }}
          label="Script style"
        >
          {context.setup.scriptStyles.map((entry) => {
            const asks = declaredFields(entry).map((field) => field.label);

            return (
              <ChoiceCard
                key={entry.id}
                value={entry.id}
                title={entry.name}
                badge={
                  entry.isDefault ? (
                    <Badge variant="secondary" className="font-normal">
                      Your default
                    </Badge>
                  ) : undefined
                }
                description={
                  asks.length > 0 ? `Asks for: ${asks.join(", ")}` : "Asks for nothing but the topic."
                }
              />
            );
          })}
        </ChoiceGroup>
      </TabsContent>
    </Tabs>
  );
}

/** One prompt-variable answer. A style's default is a placeholder, never a
 *  prefill, because an empty box is what makes `renderTemplate` fall back to
 *  it — the one-page form's rule, unchanged. */
function VariableAnswer({
  field,
  value,
  onChange,
}: {
  field: AutomationField;
  value: string;
  onChange: (next: string) => void;
}) {
  const isRequired = field.required && !field.defaultValue;

  return (
    <FormField
      name={`variable-${field.key}`}
      label={
        <>
          {field.label}
          {isRequired && (
            <>
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
              <span className="sr-only">(required)</span>
            </>
          )}
        </>
      }
      description={
        field.defaultValue && !value.trim()
          ? `Leave blank to use the style's default: ${field.defaultValue}`
          : undefined
      }
    >
      {(control) => (
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.defaultValue ?? ""}
          aria-required={isRequired || undefined}
          {...control}
        />
      )}
    </FormField>
  );
}

/** Step 2: the name, the style's own questions, and the topic queue. */
export function TopicsStep({ draft, update, context }: StepProps) {
  const style = context.setup.scriptStyles.find((entry) => entry.id === draft.promptTemplateId) ?? null;
  const fields = declaredFields(style);
  const count = parseTopics(draft.topicText).length;

  return (
    <div className="space-y-5">
      <FormField
        name="name"
        label="Series name"
        description="Just for you — it names the series in the list, in its history and on the videos it makes."
      >
        {(control) => (
          <Input
            value={draft.name}
            onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
            placeholder="Money Mechanics — weekly explainer"
            maxLength={80}
            {...control}
          />
        )}
      </FormField>

      {fields.length > 0 && (
        <div className="space-y-4 rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">
            &ldquo;{style?.name}&rdquo; asks these once for the whole series — only
            the topic changes between episodes.
          </p>
          {fields.map((field) => (
            <VariableAnswer
              key={field.key}
              field={field}
              value={draft.variables[field.key] ?? ""}
              onChange={(next) =>
                update((current) => ({
                  ...current,
                  variables: { ...current.variables, [field.key]: next },
                }))
              }
            />
          ))}
        </div>
      )}

      <FormField
        name="topics"
        label="Topics"
        description={`One per line; each episode takes the next one down. ${count} topic${
          count === 1 ? "" : "s"
        } — when the list runs out the series pauses itself and tells you, rather than inventing a subject.`}
      >
        {(control) => (
          <Textarea
            rows={8}
            value={draft.topicText}
            onChange={(event) =>
              update((current) => ({ ...current, topicText: event.target.value }))
            }
            placeholder={
              "How index funds quietly took over the stock market\n" +
              "Why airlines overbook flights\n" +
              "What a port actually does all day"
            }
            {...control}
          />
        )}
      </FormField>
    </div>
  );
}

/** A small drawing of the frame's shape, so the two format cards differ at a
 *  glance before either label is read. */
function AspectIllustration({ format }: { format: VideoFormat }) {
  return (
    <span className="bg-muted/60 flex h-24 w-full items-center justify-center rounded-lg">
      <span
        aria-hidden="true"
        className={
          format === "VERTICAL"
            ? "border-primary/60 bg-primary/10 h-18 w-10 rounded-md border-2"
            : "border-primary/60 bg-primary/10 h-12 w-21 rounded-md border-2"
        }
      />
    </span>
  );
}

/** Landscape first — it is what every video before formats existed was. */
const FORMAT_ORDER: VideoFormat[] = ["LANDSCAPE", "VERTICAL"];

/**
 * Step 3: where episodes go and what shape they are.
 *
 * Three answers on one screen, which bends the one-decision rule on purpose:
 * the project is usually decided *by* the channel (auto-picked when only one
 * project publishes there), and the format is one tap. Splitting them would be
 * two extra screens that mostly say "already done".
 */
export function ChannelStep({
  draft,
  context,
  headingId,
  onChooseChannel,
  update,
}: StepProps & { onChooseChannel: (channelId: string) => void }) {
  const projects = projectsFor(draft.channelId, context);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <ChoiceGroup
          name="channel"
          value={draft.channelId || null}
          onChange={onChooseChannel}
          labelledBy={headingId}
        >
          {context.setup.channels.map((channel) => {
            const count = projectsFor(channel.id, context).length;

            return (
              <ChoiceCard
                key={channel.id}
                value={channel.id}
                title={channel.title}
                media={
                  <span className="bg-muted flex size-10 items-center justify-center rounded-full">
                    <MonitorPlay className="text-muted-foreground size-4" />
                  </span>
                }
                description={
                  count === 0
                    ? "No project publishes here yet"
                    : `${count} project${count === 1 ? "" : "s"} publish here`
                }
              />
            );
          })}
        </ChoiceGroup>

        {/* A full-page navigation to Google and back. The draft is kept in
            this tab's session storage, so coming back here after connecting
            picks up where this left off. */}
        <Button asChild variant="link" className="h-auto px-0">
          <Link href="/api/youtube/connect">
            <Plus />
            Connect another channel
          </Link>
        </Button>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Project</h3>
        {projects.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-3 text-sm">
            No project publishes to this channel yet.{" "}
            <Link href="/projects" className="text-primary underline-offset-4 hover:underline">
              Point one at it
            </Link>{" "}
            and come back — your answers here are kept.
          </p>
        ) : projects.length === 1 ? (
          <p className="text-muted-foreground rounded-xl border px-4 py-3 text-sm">
            Episodes are filed in{" "}
            <span className="text-foreground font-medium">{projects[0].name}</span>, the
            only project that publishes to this channel.
          </p>
        ) : (
          <ChoiceGroup
            name="project"
            value={draft.projectId || null}
            onChange={(projectId) => update((current) => ({ ...current, projectId }))}
            label="Project"
            className="sm:grid-cols-2"
          >
            {projects.map((project) => (
              <ChoiceCard key={project.id} value={project.id} title={project.name} />
            ))}
          </ChoiceGroup>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Format</h3>
        <ChoiceGroup
          name="format"
          value={draft.format}
          onChange={(format) => update((current) => ({ ...current, format: format as VideoFormat }))}
          label="Format"
          className="grid-cols-2"
        >
          {FORMAT_ORDER.map((format) => {
            const facts = VIDEO_FORMATS[format];

            return (
              <ChoiceCard
                key={format}
                value={format}
                layout="tile"
                media={<AspectIllustration format={format} />}
                title={facts.label}
                description={
                  <>
                    <span className="text-foreground">{facts.aspect}</span> · {facts.summary}
                  </>
                }
              />
            );
          })}
        </ChoiceGroup>
      </div>
    </div>
  );
}
