import { z } from "zod";

/**
 * Server-only environment contract. Importing this from a client component is a
 * build error by design — every value here is a secret or a server concern.
 */
/** `z.coerce.boolean()` maps the string "false" to true, so parse the flag explicitly. */
const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /**
   * Design-preview scaffolding: stubs the session and serves fixture data so the
   * UI renders with no database. Refused in production (see below). Temporary —
   * delete alongside the *.preview.ts services once the database is running.
   */
  PREVIEW_MODE: booleanFlag,

  DATABASE_URL: z.string().url(),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url(),

  /** 32-byte key, base64 encoded. Encrypts provider API keys at rest. */
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64",
    ),

  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default("framecast"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

function loadServerEnv(): ServerEnv {
  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  // Fail the process rather than ever serving a stubbed session to real traffic.
  if (parsed.data.PREVIEW_MODE && parsed.data.NODE_ENV === "production") {
    throw new Error(
      "PREVIEW_MODE cannot be enabled in production: it bypasses authentication.",
    );
  }

  return parsed.data;
}

export const env: ServerEnv = loadServerEnv();

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
export const isPreviewMode = env.PREVIEW_MODE;
