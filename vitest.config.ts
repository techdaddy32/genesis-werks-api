import { defineConfig } from "vitest/config";

// Node/ESM test config for the Worker source. The Worker runs on the Cloudflare
// runtime in production; these are pure unit tests of the service layer with the
// Zoho/Calendar/etc. modules mocked, so the plain node environment is enough.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
