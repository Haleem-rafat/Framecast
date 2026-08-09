import "server-only";

import { env } from "@/config/env";

export interface EnvironmentProviderStatus {
  name: string;
  /** Shown as-is in the UI so the operator knows which variable(s) to set — never the value. */
  envVar: string;
  configured: boolean;
}

/**
 * Services configured via deployment env vars rather than the per-operator
 * credential vault — either shared infrastructure (AI Gateway, Google OAuth)
 * or providers AiProviderType has no member for yet (Pexels, Pixabay), so the
 * vault has nowhere to hold them. `/providers` renders these read-only,
 * alongside the vault table, so an operator with only env-configured services
 * doesn't see an all-empty page and assume nothing works.
 *
 * Returns booleans only — presence, not value — so a secret can never reach
 * the client through this path.
 */
export function getEnvironmentProviderStatuses(): EnvironmentProviderStatus[] {
  return [
    {
      name: "AI Gateway",
      envVar: "AI_GATEWAY_API_KEY",
      configured: Boolean(env.AI_GATEWAY_API_KEY),
    },
    {
      name: "Pexels",
      envVar: "PEXELS_API_KEY",
      configured: Boolean(env.PEXELS_API_KEY),
    },
    {
      name: "Pixabay",
      envVar: "PIXABAY_API_KEY",
      configured: Boolean(env.PIXABAY_API_KEY),
    },
    {
      name: "Google OAuth",
      envVar: "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET",
      // Both halves of the pair are required for OAuth to function, so treat it as
      // configured only when neither is missing.
      configured: Boolean(env.GOOGLE_CLIENT_ID) && Boolean(env.GOOGLE_CLIENT_SECRET),
    },
  ];
}
