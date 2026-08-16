import { isIP } from "node:net";

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

  /** Seeded operator address; also auto-approved on sign-up (see src/lib/auth.ts). */
  SEED_USER_EMAIL: z.string().email().optional(),
  /** Comma-separated additional addresses that skip the approvals queue. */
  AUTH_ALLOWED_EMAILS: z.string().optional(),

  /**
   * How a password-reset link reaches the person who asked for one.
   *
   * This repo has no email transport — no SMTP client, no Resend/Postmark
   * dependency, nothing. "log" is therefore the only honest option today: the
   * link is written to `ActivityLog` at WARN level and an operator relays it
   * out of band. "email" is reserved for whenever a transport is actually
   * wired up, and is refused at boot below rather than silently dropping
   * every reset on the floor while the UI claims an email was sent.
   */
  PASSWORD_RESET_DELIVERY: z.enum(["log", "email"]).default("log"),

  /**
   * Where objects live on disk. Absolute in every deployed environment
   * (`/srv/framecast/<env>/storage`); defaults to a git-ignored directory so
   * `pnpm dev` and the test suite work with no configuration.
   */
  STORAGE_ROOT: z.string().min(1).default(".framecast/storage"),

  /**
   * Where finished renders live. Separate from STORAGE_ROOT because renders
   * are ~170MB each and are deleted once YouTube confirms the upload, while
   * objects under STORAGE_ROOT have their own lifecycles. Keeping them apart
   * makes "how much disk are renders using" answerable with `du` on one
   * directory.
   */
  RENDER_ROOT: z.string().min(1).default(".framecast/renders"),

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

  /**
   * For Postgres that speaks no TLS at all — the docker-compose "full"
   * profile's own `postgres` service, reached over a private Docker network.
   * That profile hardcodes NODE_ENV=production, so this can't be refused by
   * environment the way DATABASE_SSL_INSECURE is; instead it's refused below
   * unless DATABASE_URL's host is a single-label DNS name (no dots, and not an
   * IPv4/IPv6 address literal), so it can never apply to a real domain or an IP
   * address. That check is lexical only, not a network guarantee — see the
   * comment above the check for what it does and doesn't prove.
   */
  DATABASE_SSL_DISABLE: booleanFlag,

  /** Vercel AI Gateway. Optional: a stored ANTHROPIC credential takes precedence. */
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  AI_SCRIPT_MODEL: z.string().min(1).default("anthropic/claude-sonnet-5"),
  /** Image model for thumbnails and logos, through the same gateway as
   *  AI_SCRIPT_MODEL. */
  AI_IMAGE_MODEL: z.string().min(1).default("openai/gpt-image-1"),
  /**
   * Image model for a channel's character sheet and its story illustrations —
   * a separate setting from AI_IMAGE_MODEL because they are separate jobs.
   * A thumbnail is one throwaway picture; an illustration has to hold the same
   * character across a dozen beats, which is a capability, not a preference.
   *
   * `openai/gpt-image-2` and not a Google model, and that is a licence
   * decision rather than a quality one. Google's Gemini API Additional Terms
   * say, verbatim, that you "will not use the Services as part of a website,
   * application, or other service … that is directed towards or is likely to
   * be accessed by individuals under the age of 18". A children's channel is
   * that on its face, and the clause governs Google's image models as well as
   * Veo — including Nano Banana Pro, which has the best character-reference
   * support on the gateway. Routing through Vercel does not change it; Vercel
   * is a reseller, not a novation.
   *
   * OpenAI imposes no equivalent audience restriction. Its minimum-age clause
   * ("You must be at least 13 years old…") governs who uses the service, its
   * Services Agreement §3.3(c) bars letting minors *use* the API without a
   * guardian, and its Usage Policies' "Keep minors safe" section is a harm
   * provision (CSAM, grooming, exposing minors to age-inappropriate content) —
   * none of which a bedtime story trips. Ownership is explicit in both
   * documents: "Customer … (b) owns all Output."
   *
   * Also not Seedream or FLUX: both show independently reported whole-image
   * colour drift between edits, which is precisely the artifact that stops a
   * dozen stills intercutting as one film.
   */
  AI_ILLUSTRATION_MODEL: z.string().min(1).default("openai/gpt-image-2"),

  /** Stock footage search. Platform-level, not per-operator — AiProviderType has no member for either. */
  PEXELS_API_KEY: z.string().min(1).optional(),
  PIXABAY_API_KEY: z.string().min(1).optional(),

  /** Jamendo background music. Platform-level, like the stock footage keys —
   *  AiProviderType has no per-operator credential for it either. Absent means
   *  videos render without music, not that the render fails. */
  JAMENDO_CLIENT_ID: z.string().min(1).optional(),

  /** ElevenLabs voice. Default is Roger — American, conversational. */
  ELEVENLABS_VOICE_ID: z.string().min(1).default("CwhRBWXzGAHq8TQ4Fs17"),
  ELEVENLABS_MODEL_ID: z.string().min(1).default("eleven_turbo_v2_5"),
});

/**
 * True only when `hostname` starts with a letter and otherwise contains just
 * letters, digits, and hyphens (`/^[a-zA-Z][a-zA-Z0-9-]*$/`) — e.g. `postgres`,
 * `db`, `postgres-primary`, `pg1`. That is an allowlist of what a legitimate
 * single-label DNS name looks like, not a blocklist of IP notations: no IP
 * literal, in any notation, can start with a letter, so this rejects dotted
 * IPv4, bracketed/bare IPv6, *and* the numeric IPv4 forms `node:net`'s isIP()
 * doesn't recognise as addresses (decimal `3221225985`, hex `0xCB00710A`,
 * octal `017700000001` — all of which Node's own `dns.lookup` still resolves
 * as literals via local getaddrinfo parsing, no DNS query involved). It also
 * rejects a trailing dot and anything containing a colon. The `isIP()` check
 * below is redundant with the regex today but kept as a second, differently-
 * implemented line of defense.
 *
 * This is a syntactic check, not a network one: it does not resolve the name.
 * An `/etc/hosts` entry or an internal DNS zone can point a single-label name
 * at a public address, and this function has no way to see that — resolving
 * it would require an async DNS lookup, but `loadServerEnv` (and every
 * synchronous consumer of `env`, including `PrismaClient` construction in
 * `src/lib/prisma.ts`) runs synchronously at module load, so a real
 * resolution-time check would mean restructuring app startup to be async.
 * That's out of scope here — treat this as a discipline aid that keeps
 * DATABASE_SSL_DISABLE off any hostname that is *obviously* a real domain or
 * IP literal, not as proof the target is actually private.
 */
function isSingleLabelHostname(hostname: string): boolean {
  const literal =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (isIP(literal) !== 0) {
    return false;
  }

  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(hostname);
}

export type ServerEnv = z.infer<typeof serverEnvSchema>;

function loadServerEnv(): ServerEnv {
  // Every preview deployment gets its own hostname, so the auth and app URLs
  // cannot be fixed values there. VERCEL_URL is injected per deployment.
  const deploymentUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : undefined;

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
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? deploymentUrl,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? deploymentUrl,
  };

  const parsed = serverEnvSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  // An unauthenticated database connection carries password hashes and encrypted
  // provider keys. Acceptable while developing, never against real traffic.
  if (parsed.data.DATABASE_SSL_INSECURE && parsed.data.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_SSL_INSECURE cannot be enabled in production: set SUPABASE_CA_CERT instead.",
    );
  }

  // Refusing at boot is the point: a deployment that asks for emailed reset
  // links must not start and then quietly deliver none. Remove this check in
  // the same change that adds a real transport, not before.
  if (parsed.data.PASSWORD_RESET_DELIVERY === "email") {
    throw new Error(
      'PASSWORD_RESET_DELIVERY="email" is not supported: this deployment has no ' +
        "email transport. Leave it unset to keep reset links going to the " +
        "activity log, where an operator can relay them.",
    );
  }

  // DATABASE_SSL_DISABLE turns off TLS negotiation entirely, so it's valid only
  // for a single-label container/service hostname — never a dotted domain and
  // never an IPv4/IPv6 address literal (see isSingleLabelHostname's doc comment
  // for exactly what this check does and does not prove). Checked regardless of
  // NODE_ENV, since the docker-compose "full" profile that needs this flag
  // hardcodes NODE_ENV=production.
  if (parsed.data.DATABASE_SSL_DISABLE) {
    const { hostname } = new URL(parsed.data.DATABASE_URL);
    if (!isSingleLabelHostname(hostname)) {
      throw new Error(
        `DATABASE_SSL_DISABLE cannot be used with DATABASE_URL host "${hostname}": ` +
          "it must be a single-label container/service name — not a dotted domain " +
          "and not an IPv4 or IPv6 address literal.",
      );
    }
  }

  return parsed.data;
}

export const env: ServerEnv = loadServerEnv();

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
