import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      /**
       * The `server-only` package throws unless the bundler sets the
       * `react-server` export condition, which Next.js does and Vitest does
       * not. Every service imports it, so without this alias each service test
       * fails at import rather than on any behaviour under test.
       */
      "server-only": fileURLToPath(
        new URL("./src/test/server-only.stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // Service tests run against a real Supabase database in another region, so
    // a single round trip costs ~130ms and a stage that uploads to storage costs
    // seconds. Vitest's 5s default fails honest tests for being far away rather
    // than for being wrong.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["src/test/setup.ts"],
    // Service tests share one Postgres database; parallel files would race on
    // the same rows.
    fileParallelism: false,
  },
});
