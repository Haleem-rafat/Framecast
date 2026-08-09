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
    setupFiles: ["src/test/setup.ts"],
    // Service tests share one Postgres database; parallel files would race on
    // the same rows.
    fileParallelism: false,
  },
});
