import { type SerializedError, toSerializedError } from "@/lib/errors";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedError };

/**
 * Single funnel for every server action, so a thrown driver message can never
 * reach the browser by someone forgetting a try/catch.
 */
export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: toSerializedError(error) };
  }
}
