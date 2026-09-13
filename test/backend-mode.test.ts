//==============================================================================
// backend-mode.test.ts — tenant_settings `backend.mode` resolution (P2).
//==============================================================================

import { describe, it, expect, afterAll } from "vitest";
import { backendMode, isPostgresBackend, parseBackendMode, _clearBackendModeCache } from "../src/backend-mode";
import { FHI_TENANT, createScratchTenant, dbAvailable, sharedSql, testEnv } from "./_pg";
import { withTenant } from "../src/db";
import { setSetting } from "../src/settings";
import { SANDBOX_TENANT } from "../scripts/reset-sandbox";

const up = await dbAvailable();

describe("parseBackendMode", () => {
  it("only the exact word postgres selects Postgres; everything else is zoho", () => {
    expect(parseBackendMode("postgres")).toBe("postgres");
    expect(parseBackendMode(" Postgres ")).toBe("postgres");
    expect(parseBackendMode("zoho")).toBe("zoho");
    expect(parseBackendMode(undefined)).toBe("zoho");
    expect(parseBackendMode(null)).toBe("zoho");
    expect(parseBackendMode(1)).toBe("zoho");
  });

  it("without a database or a tenant the answer is zoho (the Zoho-mocked suites run DB-less)", async () => {
    expect(await backendMode({} as never)).toBe("zoho");
    expect(await backendMode({ DATABASE_URL: "postgres://x" } as never)).toBe("zoho"); // no TENANT_ID
    expect(await backendMode({ TENANT_ID: FHI_TENANT } as never)).toBe("zoho"); // no DB
  });
});

describe.skipIf(!up)("backend.mode from tenant_settings", () => {
  const sql = sharedSql();
  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  it("FHI is zoho, the sandbox is postgres (0004_backend_mode.sql)", async () => {
    _clearBackendModeCache();
    expect(await backendMode(testEnv({ TENANT_ID: FHI_TENANT }))).toBe("zoho");
    expect(await isPostgresBackend(testEnv({ TENANT_ID: SANDBOX_TENANT }))).toBe(true);
  });

  it("a tenant without the key defaults to zoho; flipping the setting takes effect once the cache is cleared", async () => {
    const env = testEnv();
    const tenant = await createScratchTenant(env, sql, "mode");
    const t = testEnv({ TENANT_ID: tenant });
    _clearBackendModeCache();
    expect(await backendMode(t)).toBe("zoho");
    await withTenant(env, tenant, (tx) => setSetting(tx, "backend.mode", "postgres"), { sql });
    expect(await backendMode(t)).toBe("zoho"); // cached (30 s)
    _clearBackendModeCache();
    expect(await backendMode(t)).toBe("postgres");
    // a tx-scoped read is never cached
    expect(await withTenant(env, tenant, (tx) => backendMode(t, tx), { sql })).toBe("postgres");
  });

  it("an unreachable database degrades to zoho instead of throwing", async () => {
    _clearBackendModeCache();
    expect(await backendMode(testEnv({ DATABASE_URL: "postgres://nobody@127.0.0.1:1/nope", TENANT_ID: SANDBOX_TENANT }))).toBe("zoho");
    _clearBackendModeCache();
  });
});
