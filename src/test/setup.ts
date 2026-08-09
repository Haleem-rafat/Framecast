import { config } from "dotenv";

// Mirrors prisma.config.ts: .env.local wins over .env.
config({ path: ".env.local" });
config({ path: ".env" });
