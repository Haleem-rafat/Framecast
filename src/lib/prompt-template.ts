import { ValidationError } from "@/lib/errors";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface VariableDefinition {
  key: string;
  required: boolean;
  defaultValue: string | null;
}

export function extractVariables(content: string): string[] {
  const found = content.matchAll(PLACEHOLDER);

  return [...new Set([...found].map((match) => match[1]))];
}

/**
 * Unknown placeholders are deliberately left in place rather than emptied: a
 * mistyped `{{topc}}` should be obvious in the output, not silently produce a
 * subtly wrong prompt.
 */
export function renderTemplate(
  content: string,
  values: Record<string, string>,
  definitions: VariableDefinition[],
): string {
  const byKey = new Map(definitions.map((one) => [one.key, one]));
  const missing: string[] = [];

  const rendered = content.replace(PLACEHOLDER, (original, key: string) => {
    const definition = byKey.get(key);

    // Definitions are authoritative: a placeholder nobody declared is a typo, and
    // must stay visible in the output rather than being filled from a stray value.
    if (!definition) {
      return original;
    }

    const supplied = values[key]?.trim();

    if (supplied) {
      return supplied;
    }

    if (definition.defaultValue) {
      return definition.defaultValue;
    }

    if (definition.required) {
      missing.push(key);
    }

    return "";
  });

  if (missing.length > 0) {
    throw new ValidationError(
      `Required variable${missing.length === 1 ? "" : "s"} missing: ${missing.join(", ")}`,
      {
        variables: missing,
      },
    );
  }

  return rendered;
}
