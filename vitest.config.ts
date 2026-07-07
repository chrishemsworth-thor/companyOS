import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      // The UI package has its own jsdom-based vitest config (ui/vitest.config.ts).
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Exposed to test/setup.ts so migrations run before each test file.
            bindings: { TEST_MIGRATIONS: migrations },
            // Queue consumption is tested by feeding batches into
            // handleEventBatch directly; keep miniflare from auto-delivering
            // mid-test (delivery runs outside the isolated-storage frame,
            // where migrations haven't been applied).
            queueConsumers: {
              "companyos-events": { maxBatchSize: 100, maxBatchTimeout: 60 },
            },
          },
        },
      },
    },
  };
});
