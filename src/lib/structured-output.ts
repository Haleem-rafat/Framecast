/**
 * Making a failed `generateObject` call diagnosable, and repairing the one
 * malformed answer that is worth repairing.
 *
 * `generateObject` collapses two completely different faults into one thrown
 * value. Either the provider never answered — no key, wrong model id, a 429, a
 * gateway 5xx — or it answered perfectly well and the answer did not fit the
 * schema. The first is the platform's problem and usually needs a human; the
 * second is the model's problem and usually clears on a retry. A catch block
 * that reports both as "the model provider failed" tells the operator to do the
 * wrong thing in one of those two cases, and tells whoever reads the logs
 * nothing at all in both — which is exactly how the shorts feature's first
 * production failure turned into an investigation instead of a second click.
 *
 * Nothing here is shorts-specific. It is in `lib` rather than beside its one
 * caller because every `generateObject` call in this codebase runs the same
 * risk; adopting it elsewhere is a one-line change at the call site.
 */

/**
 * How much of any single provider-supplied string is kept in a log line.
 *
 * Bounded for the same reason `shorts.service.ts` keeps only the tail of
 * FFmpeg's stderr: a `TypeValidationError` quotes the model's entire rejected
 * answer back at you, and an unbounded log line per failure is a way for a
 * chatty model to fill a disk. The head rather than the tail is kept here
 * because these messages lead with the part that identifies the fault.
 */
const MAX_DETAIL_CHARS = 800;

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_DETAIL_CHARS)}… (${value.length} chars)`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Every error in a `cause` chain, outermost first.
 *
 * The AI SDK nests: a `NoObjectGeneratedError` carries the
 * `TypeValidationError` that rejected the answer, and an API failure carries
 * the `APICallError` that holds the status code and the response body. Reading
 * only the outer error is why the wrapper messages in this codebase used to say
 * so little — the outermost message is always the most generic one in the
 * chain. `seen` guards against a self-referential cause rather than trusting
 * providers not to build one.
 */
function* causeChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * The HTTP status behind a provider failure, wherever in the cause chain it
 * sits.
 *
 * Deliberately not a plain `error.statusCode` read. When `generateObject`
 * rejects because the *transport* failed, the thrown error is the
 * `APICallError` itself and the status is on top; when it rejects because the
 * answer was unusable, the thrown error is a `NoObjectGeneratedError` and any
 * status is one or two levels down. A top-level-only read returns `undefined`
 * for the second case, which is harmless, and `undefined` for a rate limit
 * wrapped one level deep, which is not — that is a retryable failure being
 * classified as a permanent one.
 */
export function providerStatusCode(error: unknown): number | undefined {
  for (const link of causeChain(error)) {
    const status = (link as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") {
      return status;
    }
  }

  return undefined;
}

/** 429 and 5xx are transient; everything else means the request itself is
 *  wrong. Same rule as `isRetryable` in gateway.provider.ts, applied to the
 *  whole cause chain rather than to the outermost error alone. */
export function isRetryableProviderFailure(error: unknown): boolean {
  const status = providerStatusCode(error);

  return status === 429 || (status !== undefined && status >= 500);
}

function describeLink(error: unknown): string {
  if (!(error instanceof Error)) {
    return truncate(String(error));
  }

  const parts = [`${error.name}: ${truncate(error.message)}`];
  const extras = error as unknown as Record<string, unknown>;

  if (typeof extras.statusCode === "number") {
    parts.push(`status ${extras.statusCode}`);
  }
  if (typeof extras.url === "string") {
    parts.push(`url ${extras.url}`);
  }

  // `responseBody` is what an `APICallError` carries; `text` is what a
  // `NoObjectGeneratedError` carries — the raw answer the schema rejected,
  // which is the single most useful thing in the whole chain when a model has
  // answered in the wrong shape. Never `requestBodyValues`: that is the prompt
  // going back out again, which is noise here and in some deployments is the
  // operator's own script.
  const body =
    typeof extras.responseBody === "string"
      ? extras.responseBody
      : typeof extras.text === "string"
        ? extras.text
        : undefined;

  if (body !== undefined && body !== "") {
    parts.push(`body ${truncate(body)}`);
  }

  return parts.join(" | ");
}

/**
 * A single log line describing what the provider actually did, assembled from
 * the whole cause chain.
 *
 * This exists so that the next failure of a structured call is answerable from
 * `docker compose logs` in one step. It is for the server log only — the
 * user-facing message is written by the caller, which knows what the operator
 * can do about it; this string knows what happened.
 */
export function describeProviderFailure(error: unknown): string {
  const described = [...causeChain(error)].map(describeLink);

  return described.length === 0 ? "unknown failure (no error value)" : described.join(" <- ");
}

/**
 * Un-nests a structured answer that the model JSON-encoded into its own
 * property, returning repaired JSON text or `null` when this is not that fault.
 *
 * The shape being repaired, observed reproducibly against
 * `anthropic/claude-sonnet-5` through the AI Gateway:
 *
 *     {"moments": "{\"moments\": [ {…}, {…}, {…} ]}"}
 *
 * The model builds the right answer and then serialises the whole object into
 * the string slot of its own single property, so schema validation sees a
 * string where an array belongs and `generateObject` throws — with the correct
 * answer sitting inside the error.
 *
 * It is a property of the request, not a coin flip: the same prompt and schema
 * fail on every attempt with a top-level property named `moments`, `clips` or
 * `elements` and succeed on every attempt with one named `sections` or `items`.
 * That rules out the obvious workaround. Renaming the field would fix the
 * observed case by accident and leave the next schema to rediscover it in
 * production, whereas this repair is defined by the malformed shape and does
 * not care what the property is called.
 *
 * Safe to wire into any `generateObject` call because the SDK only invokes a
 * repair function *after* parsing or validation has already failed: on every
 * answer that was going to work, this code never runs. It is narrowed to
 * single-property objects on purpose — a schema with several top-level fields
 * has never been seen to fail this way, and unwrapping a string field that
 * legitimately contains JSON would corrupt an answer rather than rescue one.
 */
export function repairDoubleEncodedObject(text: string): string | null {
  const outer = parseJson(text);
  if (!outer.ok) {
    // Not JSON at all — a truncated answer, or prose where an object was
    // asked for. A different fault, and not one this function can invent a
    // repair for.
    return null;
  }

  // The whole answer encoded as one JSON string, rather than one property of
  // it. Same mistake one level up, and the same repair: hand back what the
  // string actually held.
  if (typeof outer.value === "string") {
    const inner = parseJson(outer.value);
    return inner.ok && isPlainObject(inner.value) ? outer.value : null;
  }

  if (!isPlainObject(outer.value)) {
    return null;
  }

  const entries = Object.entries(outer.value);
  if (entries.length !== 1) {
    return null;
  }

  const [key, value] = entries[0];
  if (typeof value !== "string") {
    return null;
  }

  const inner = parseJson(value);
  if (!inner.ok) {
    return null;
  }

  // Usually the model re-wrapped the property around its own value, so the
  // decoded string is already the complete answer and can be returned as it
  // stands. When it did not, the string held only the property's value and it
  // goes back into the slot it belongs in.
  if (isPlainObject(inner.value) && key in inner.value) {
    return value;
  }

  return JSON.stringify({ [key]: inner.value });
}
