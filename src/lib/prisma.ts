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
 * its default trust store — hence the explicit CA. Three tiers, most secure first:
 *
 *   1. SUPABASE_CA_CERT present → verify against it. The only production-valid mode.
 *   2. DATABASE_SSL_INSECURE=true → encrypted but unauthenticated. Local only;
 *      `config/env.ts` refuses it when NODE_ENV=production.
 *   3. Neither → strict verification, which fails loudly against Supabase rather
 *      than quietly downgrading.
 *
 * Local docker-compose Postgres speaks no TLS at all, so remote hosts only.
 */
function sslOptions(hostname: string) {
  const isRemote = hostname !== "localhost" && hostname !== "127.0.0.1";

  if (!isRemote) {
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
