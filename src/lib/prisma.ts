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
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

  return new PrismaClient({
    adapter,
    log: isDevelopment ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (isDevelopment) {
  globalForPrisma.prisma = prisma;
}
