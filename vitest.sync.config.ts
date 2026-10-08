// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
import { defineConfig } from "vitest/config";

// The walk-tool sync suite (new schema, work/migrations 001→090). Kept apart from
// vitest.config.ts because main's suite describes the tenant-era schema (public.*,
// app.tenant_id) and is not run on sandbox/walk-tool. Run with:
//   npx vitest run --config vitest.sync.config.ts
// (or `npx vitest run test/sync` — the include below is what matters).
// Needs TEST_DATABASE_URL (genesis_api) + TEST_OWNER_DATABASE_URL (owner) — see test/sync/_db.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/sync/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
