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

function createPrismaClient(): PrismaClient {
  const connectionUrl = new URL(env.DATABASE_URL);
  const isRemote =
    connectionUrl.hostname !== "localhost" && connectionUrl.hostname !== "127.0.0.1";

  // node-postgres treats `sslmode=require` (what Supabase's pooler URL sets) as
  // an alias for `verify-full`, which then rejects Supabase's pooler certificate
  // chain. The connection is still encrypted, just not chain-validated — the
  // documented workaround for Supabase + node-postgres. Local docker-compose
  // Postgres has no SSL at all, so this only applies to remote hosts.
  if (isRemote) {
    connectionUrl.searchParams.delete("sslmode");
  }

  const adapter = new PrismaPg({
    connectionString: connectionUrl.toString(),
    ...(isRemote ? { ssl: { rejectUnauthorized: false } } : {}),
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
