import { config } from "dotenv";

// Mirrors prisma.config.ts: .env.local wins over .env.
config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Refuses to run the suite against a database a render worker is polling.
 *
 * These tests create videos and approve them, which is precisely the state a
 * worker's `claimNext` is looking for. Run against `framecast_staging` — which
 * is what `.env.local` points at, because the local dev server wants real data —
 * the live worker claims the test's video within seconds, fails narration
 * against the fixture's deliberately-fake ElevenLabs key, and marks it FAILED.
 * The test then reads that aftermath and reports a defect that does not exist.
 *
 * It cost two agents a long investigation each before the cause was found, and
 * the symptom is maddening: a different test fails on each run, in a file
 * nobody touched. Worse, the writes land in a real environment's database.
 *
 * So: point tests at a database with no worker on it. `TEST_DATABASE_URL` wins
 * when set; otherwise a `DATABASE_URL` naming any non-test database is switched
 * to `framecast_test` on the same host rather than silently used. A suite that
 * refuses to start beats one that quietly corrupts staging.
 */
const TEST_DATABASE_NAME = "framecast_test";

function resolveTestDatabaseUrl(): string | null {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return explicit;

  const current = process.env.DATABASE_URL;
  if (!current) return null;

  try {
    const url = new URL(current);
    // `/framecast`, `/framecast_staging` → `/framecast_test`. Already-correct
    // URLs are returned untouched so this is a no-op in CI.
    if (url.pathname === `/${TEST_DATABASE_NAME}`) return current;

    url.pathname = `/${TEST_DATABASE_NAME}`;
    return url.toString();
  } catch {
    // An unparseable URL is the database layer's problem to report, with its
    // own far better error message than anything this could invent.
    return null;
  }
}

const testUrl = resolveTestDatabaseUrl();

if (testUrl) {
  process.env.DATABASE_URL = testUrl;
}
