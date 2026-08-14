import { z } from "zod";

/**
 * Same character class `promptVariableSchema` (prompt.schema.ts) enforces on a
 * `PromptVariable.key`. The guided flow only ever submits keys it read back
 * off the operator's own template, so anything outside this set is a
 * hand-crafted payload rather than a real form submission — and
 * `renderTemplate` would leave such a placeholder un-substituted anyway (see
 * src/lib/prompt-template.ts), so accepting it would only widen what reaches
 * the model without ever changing the prompt.
 */
const variableKeySchema = z.string().regex(/^[a-zA-Z0-9_]+$/);

/**
 * Ceiling on how many variables one submission may carry. A prompt template
 * can declare at most 20 (`upsertPromptSchema.variables.max(20)`), and the
 * flow renders one field per declared variable, so double that is far past
 * any real form while still bounding what an arbitrary POST can hand the
 * service to iterate over.
 */
const MAX_VARIABLES = 40;

/**
 * Everything the guided flow collects. Deliberately smaller than
 * `createVideoSchema`: there is no `title` field because the flow never asks
 * for one — see `AutomationService.start`, which derives an internal working
 * title from the topic and lets the pipeline's metadata stage produce the real
 * YouTube title later.
 *
 * `topic`'s bounds are copied from `createVideoSchema` rather than loosened,
 * so a topic accepted here is one the manual "New video" dialog would also
 * have accepted — the two entry points must not disagree about what a valid
 * topic is.
 */
export const startAutomationSchema = z.object({
  projectId: z.string().uuid(),
  topic: z.string().min(3, "Give the topic a few more words").max(300),
  /**
   * Values for the operator's own prompt variables, keyed by `PromptVariable.key`.
   * Never validated against a fixed list here: which variables exist is a
   * property of the operator's default SCRIPT template, which they can edit at
   * any time. `AutomationService` is what reconciles this map against the
   * template's real declared variables — including dropping anything the
   * template does not declare.
   */
  variables: z
    .record(variableKeySchema, z.string().max(500))
    .refine((value) => Object.keys(value).length <= MAX_VARIABLES, {
      message: `A prompt cannot declare more than ${MAX_VARIABLES} variables.`,
    })
    .default({}),
});

export type StartAutomationInput = z.infer<typeof startAutomationSchema>;
