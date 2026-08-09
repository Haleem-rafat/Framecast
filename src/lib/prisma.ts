import { PrismaPg } from "@prisma/adapter-pg";

import { env, isDevelopment } from "@/config/env";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Next.js dev-mode HMR re-evaluates modules on every edit; without caching the
 * instance on globalThis each reload would open a new connection pool.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Supabase signs Postgres with its own CA, so Node cannot verify the chain from
 * its default trust store — hence the explicit CA. Four tiers, most secure first:
 *
 *   1. DATABASE_SSL_DISABLE=true → no TLS negotiated at all. For Postgres that
 *      speaks no TLS whatsoever, e.g. the docker-compose "full" profile's own
 *      `postgres` service (plain postgres:17-alpine, SSL off). That profile
 *      hardcodes NODE_ENV=production, so this can't be gated on environment the
 *      way DATABASE_SSL_INSECURE is — instead `config/env.ts` refuses it
 *      outright whenever DATABASE_URL's hostname contains a dot, so it can never
 *      apply to a real (or public-IP) domain, only to bare container/service
 *      names on a private Docker network.
 *   2. SUPABASE_CA_CERT present → verify against it. The only production-valid
 *      mode for a real Supabase host.
 *   3. DATABASE_SSL_INSECURE=true → encrypted but unauthenticated. Local only;
 *      `config/env.ts` refuses it when NODE_ENV=production.
 *   4. None of the above → strict verification, which fails loudly against
 *      Supabase rather than quietly downgrading.
 *
 * localhost/127.0.0.1 are also assumed to speak no TLS (same as tier 1) since
 * that's the shape of `pnpm dev` against docker-compose's postgres port mapping.
 */
function sslOptions(hostname: string) {
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1";

  if (isLoopback || env.DATABASE_SSL_DISABLE) {
    return undefined;
  }

  if (env.SUPABASE_CA_CERT) {
    return { ca: env.SUPABASE_CA_CERT, rejectUnauthorized: true };
  }

  if (env.DATABASE_SSL_INSECURE) {
    console.warn(
      "⚠️  Database TLS certificate is NOT being verified " +
        "(DATABASE_SSL_INSECURE=true). Set SUPABASE_CA_CERT before deploying.",
    );

    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

function createPrismaClient(): PrismaClient {
  const connectionUrl = new URL(env.DATABASE_URL);
  const ssl = sslOptions(connectionUrl.hostname);

  // node-postgres reads `sslmode` itself and it would override the `ssl` object
  // below, so the explicit configuration has to be the only source of truth.
  connectionUrl.searchParams.delete("sslmode");

  const adapter = new PrismaPg({
    connectionString: connectionUrl.toString(),
    ...(ssl ? { ssl } : {}),
  });

  return new PrismaClient({
    adapter,
    log: isDevelopment ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (isDevelopment) {
  globalForPrisma.prisma = prisma;
}
