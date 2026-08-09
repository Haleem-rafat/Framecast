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
  /** Unpooled connection. Migrations run DDL, which pgBouncer cannot proxy safely. */
  DIRECT_URL: z.string().url(),

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

  /**
   * Supabase's PEM root certificate. Supabase signs Postgres with its own CA,
   * which is not in Node's trust store, so without this the chain cannot be
   * verified. Download it from Project Settings → Database → SSL Configuration.
   */
  SUPABASE_CA_CERT: z.string().min(1).optional(),

  /**
   * Escape hatch for local work before the CA cert is on hand. Encrypts the
   * connection but does not authenticate the server, so a network attacker can
   * impersonate the database. Refused in production — see below.
   */
  DATABASE_SSL_INSECURE: booleanFlag,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

function loadServerEnv(): ServerEnv {
  // Supabase's Vercel integration injects POSTGRES_* names. Local docker-compose
  // sets DATABASE_URL directly, so an explicit value always wins.
  const source = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? process.env.POSTGRES_PRISMA_URL,
    DIRECT_URL:
      process.env.DIRECT_URL ??
      process.env.POSTGRES_URL_NON_POOLING ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_PRISMA_URL,
  };

  const parsed = serverEnvSchema.safeParse(source);

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

  // An unauthenticated database connection carries password hashes and encrypted
  // provider keys. Acceptable while developing, never against real traffic.
  if (parsed.data.DATABASE_SSL_INSECURE && parsed.data.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_SSL_INSECURE cannot be enabled in production: set SUPABASE_CA_CERT instead.",
    );
  }

  return parsed.data;
}

export const env: ServerEnv = loadServerEnv();

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
export const isPreviewMode = env.PREVIEW_MODE;
