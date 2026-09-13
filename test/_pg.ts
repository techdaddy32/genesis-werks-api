//==============================================================================
// _pg.ts — shared helpers for the F2 database tests (not a test file itself).
//
// Connects with a DIRECT postgres:// URL (env.DATABASE_URL fallback in db.ts),
// never Hyperdrive. Default = the `genesis_api` role (NOBYPASSRLS) so the
// tenant_isolation RLS policies actually apply during the tests. Set
// TEST_DATABASE_URL to override. See F2-NOTES.md "How to run the tests".
//
// Every suite that mutates data works in a SCRATCH TENANT (fresh uuid, fresh
// sequences) so re-running against the same database stays deterministic.
//==============================================================================

import postgres from "postgres";
import type { Env } from "../src/types";
import { withTenant, withTenantRead, type Sql } from "../src/db";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://genesis_api:test@localhost:5432/gw_test";

/** The FHI tenant seeded by 0002_seed_fhi.sql. */
export const FHI_TENANT = "f4100000-0000-4000-8000-000000000001";

/** Minimal Env for the DB layer: DATABASE_URL fallback + TENANT_ID. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    TENANT_ID: FHI_TENANT,
    ...overrides,
  } as unknown as Env;
}

/** True when the test database answers `select 1` within ~3s. Never throws. */
export async function dbAvailable(): Promise<boolean> {
  let sql: Sql | null = null;
  try {
    sql = postgres(TEST_DATABASE_URL, { prepare: false, max: 1, fetch_types: false, connect_timeout: 3 });
    const rows = await sql`select 1 as one`;
    return rows.length === 1;
  } catch {
    return false;
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/** A shared client for a suite (so concurrency tests do not open hundreds of sockets). */
export function sharedSql(max = 5): Sql {
  return postgres(TEST_DATABASE_URL, { prepare: false, max, fetch_types: false });
}

/**
 * Create a scratch tenant with the FHI numbering.* settings copied over.
 * Returns its uuid. Works under genesis_api because the tenants policy is
 * `id = app_tenant_id()` and tenant_settings' is `tenant_id = app_tenant_id()`.
 */
export async function createScratchTenant(env: Env, sql: Sql, label = "scratch"): Promise<string> {
  const id = crypto.randomUUID();
  const numbering = await withTenantRead(
    env,
    FHI_TENANT,
    (tx) => tx<{ key: string; value: unknown }[]>`
      select key, value from public.tenant_settings
      where tenant_id = public.app_tenant_id() and (key like 'numbering.%' or key = 'app.timezone')`,
    { sql }
  );
  await withTenant(
    env,
    id,
    async (tx) => {
      await tx`insert into public.tenants (id, name, slug) values (${id}, ${`Test ${label}`}, ${`test-${id.slice(0, 8)}`})`;
      for (const s of numbering) {
        await tx`insert into public.tenant_settings (tenant_id, key, value) values (${id}, ${s.key}, ${tx.json(s.value as never)})`;
      }
    },
    { sql }
  );
  return id;
}
