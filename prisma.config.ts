import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// .env.local holds the Supabase values written by `vercel env pull`; it must load
// first so it overrides the local docker-compose defaults in .env.
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["POSTGRES_URL_NON_POOLING"] ?? process.env["DATABASE_URL"],
  },
});
