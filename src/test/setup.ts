import { config } from "dotenv";

// Mirrors prisma.config.ts: .env.local wins over .env.
config({ path: ".env.local" });
config({ path: ".env" });

// Not NODE_ENV — Vitest sets that itself, and @types/node marks it read-only.
process.env.PREVIEW_MODE = "false";
