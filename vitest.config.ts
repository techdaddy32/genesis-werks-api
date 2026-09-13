import { defineConfig } from "vitest/config";

// Node/ESM test config for the Worker source. The Worker runs on the Cloudflare
// runtime in production; these are pure unit tests of the service layer with the
// Zoho/Calendar/etc. modules mocked, so the plain node environment is enough.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // P2: the pg-*.test.ts suites and sandbox-seed.test.ts all reset + mutate the ONE
    // sandbox tenant (f4100000-…0002), so test files must not interleave. Files run
    // one after another; tests inside a file still run in order as before.
    fileParallelism: false,
  },
});
