//==============================================================================
// sandbox-seed.test.ts — 0003_seed_sandbox.sql + scripts/reset-sandbox.ts (SB1).
//
// Applies the seed AS POSTGRES (the migration runs as the owner on Supabase
// too), then reads the sandbox AS genesis_api bound to the sandbox tenant, so
// every assertion goes through RLS exactly as the API would. The FHI tenant is
// counted before and after to prove the seed is tenant-local.
//
// Needs, besides TEST_DATABASE_URL (genesis_api): an OWNER connection —
//   TEST_ADMIN_DATABASE_URL   default postgres://postgres:test@localhost:5432/gw_test
// Skipped when either is down.
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { FHI_TENANT, dbAvailable, sharedSql, testEnv } from "./_pg";
import { withTenant, withTenantRead, type Sql } from "../src/db";
import type { Env } from "../src/types";
import {
  SANDBOX_TENANT,
  SEED_SQL_PATH,
  WIPE_ORDER,
  databaseNameOf,
  looksLikeProd,
  resetSandbox,
  sandboxCounts,
  seedSandbox,
  tenantTables,
  wipeSandbox,
} from "../scripts/reset-sandbox";

/** Throwable used to roll back the mint transaction while keeping its result. */
class Rollback extends Error {
  constructor(public readonly row: unknown) {
    super("rollback");
  }
}

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:test@localhost:5432/gw_test";

async function adminAvailable(): Promise<boolean> {
  let sql: Sql | null = null;
  try {
    sql = postgres(ADMIN_URL, { prepare: false, max: 1, fetch_types: false, connect_timeout: 3 });
    const rows = await sql<{ owner: string }[]>`select pg_get_userbyid(relowner) as owner from pg_class where relname = 'events' and relnamespace = 'public'::regnamespace`;
    const me = await sql<{ u: string }[]>`select current_user as u`;
    return rows.length === 1 && rows[0].owner === me[0].u;
  } catch {
    return false;
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

const up = (await dbAvailable()) && (await adminAvailable());
const seedSql = readFileSync(SEED_SQL_PATH, "utf8");

/** Counts the FHI tenant's rows in a few tables the seed also writes (as genesis_api, bound to FHI). */
async function fhiCounts(env: Env, sql: Sql): Promise<Record<string, number>> {
  return withTenantRead(
    env,
    FHI_TENANT,
    async (tx) => {
      const out: Record<string, number> = {};
      for (const table of ["tenant_settings", "status_vocab", "users", "projects", "work_orders", "sequences", "field_definitions"]) {
        const r = await tx<{ n: string }[]>`select count(*)::text as n from public.${tx(table)} where tenant_id = public.app_tenant_id()`;
        out[table] = Number(r[0].n);
      }
      return out;
    },
    { sql }
  );
}

describe("reset-sandbox helpers (pure)", () => {
  it("prod guard keys on the database NAME, not the host", () => {
    expect(databaseNameOf("postgres://u:p@db.example.com:5432/gw_prod")).toBe("gw_prod");
    expect(looksLikeProd("postgres://u:p@db.example.com:5432/gw_prod")).toBe(true);
    expect(looksLikeProd("postgres://u:p@prod-host.example.com:5432/postgres")).toBe(false);
    expect(looksLikeProd("postgres://u:p@localhost:5432/gw_test")).toBe(false);
    expect(looksLikeProd("not a url")).toBe(false);
  });
  it("the seed file is guarded by the fixed sandbox uuid and never names the FHI tenant", () => {
    expect(seedSql).toContain(SANDBOX_TENANT);
    expect(seedSql).not.toContain(FHI_TENANT);
  });
});

describe.skipIf(!up)("0003_seed_sandbox.sql + reset-sandbox (Postgres)", () => {
  let admin: Sql;
  let api: Sql;
  let env: Env;
  let fhiBefore: Record<string, number>;
  let counts: Record<string, number>;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { prepare: false, max: 1, fetch_types: false, onnotice: () => undefined });
    api = sharedSql();
    env = testEnv({ TENANT_ID: SANDBOX_TENANT });
    fhiBefore = await fhiCounts(env, api);
    // start from a clean sandbox whatever an earlier run left, then apply the migration
    await wipeSandbox(admin);
    await seedSandbox(admin, seedSql);
    counts = await sandboxCounts(admin);
  }, 60_000);

  afterAll(async () => {
    await admin.end({ timeout: 2 });
    await api.end({ timeout: 2 });
  });

  it("WIPE_ORDER covers every tenant-bearing table except events", async () => {
    const tables = await tenantTables(admin);
    const missing = tables.filter((t) => t !== "events" && !WIPE_ORDER.includes(t));
    expect(missing).toEqual([]);
    expect(new Set(WIPE_ORDER).size).toBe(WIPE_ORDER.length);
  });

  it("seeds the tenant, 9 users, 8 projects, ≥ 24 work orders and the rest of the month", async () => {
    expect(counts.tenants).toBe(1);
    expect(counts.users).toBe(9);
    expect(counts.user_roles).toBe(9);
    expect(counts.projects).toBe(8);
    expect(counts.work_orders).toBeGreaterThanOrEqual(24);
    expect(counts.accounts).toBe(6);
    expect(counts.contacts).toBe(12);
    expect(counts.deals).toBe(5);
    expect(counts.action_items).toBe(8);
    expect(counts.reminders).toBe(2);
    expect(counts.field_definitions).toBe(3);
    expect(counts.visits).toBeGreaterThan(0);
    expect(counts.items).toBeGreaterThan(0);
    expect(counts.hours_entries).toBeGreaterThan(0);
    expect(counts.daily_reports).toBeGreaterThan(0);
    expect(counts.events).toBeGreaterThanOrEqual(counts.work_orders);
  });

  it("as genesis_api bound to the sandbox: tenant row, roles, every WO has a work + billing task", async () => {
    const r = await withTenantRead(
      env,
      SANDBOX_TENANT,
      async (tx) => ({
        tenant: await tx<{ slug: string; name: string }[]>`select slug, name from public.tenants where id = public.app_tenant_id()`,
        roles: await tx<{ role: string; n: string }[]>`
          select role, count(*)::text as n from public.user_roles where tenant_id = public.app_tenant_id() group by role order by role`,
        techs: await tx<{ email: string }[]>`select email from public.v_technicians where tenant_id = public.app_tenant_id()`,
        noWork: await tx<{ n: string }[]>`
          select count(*)::text as n from public.work_orders wo
          where wo.tenant_id = public.app_tenant_id() and wo.deleted_at is null
            and not exists (select 1 from public.wo_tasks k where k.work_order_id = wo.id and k.kind = 'work' and k.deleted_at is null)`,
        noBilling: await tx<{ n: string }[]>`
          select count(*)::text as n from public.work_orders wo
          where wo.tenant_id = public.app_tenant_id() and wo.deleted_at is null
            and not exists (select 1 from public.wo_tasks k where k.work_order_id = wo.id and k.kind = 'billing' and k.deleted_at is null)`,
        keys: await tx<{ public_key: string }[]>`select public_key from public.projects where tenant_id = public.app_tenant_id() order by public_key`,
      }),
      { sql: api }
    );
    expect(r.tenant).toEqual([{ slug: "sandbox", name: "Genesis Sandbox" }]);
    expect(Object.fromEntries(r.roles.map((x) => [x.role, Number(x.n)]))).toEqual({ admin: 1, office: 2, sales: 1, technician: 5 });
    expect(r.techs).toHaveLength(5);
    for (const t of r.techs) expect(t.email).toMatch(/@genesis-sandbox\.example$/);
    expect(Number(r.noWork[0].n)).toBe(0);
    expect(Number(r.noBilling[0].n)).toBe(0);
    expect(r.keys.map((k) => k.public_key)).toEqual(["GS-101", "GS-102", "GS-103", "GS-104", "GS-105", "GS-106", "GS-107", "GS-108"]);
  });

  it("v_work_orders: every row has a public_key of the numbering pattern and a vocab-valid status; the board covers all 8 states", async () => {
    const r = await withTenantRead(
      env,
      SANDBOX_TENANT,
      async (tx) => ({
        rows: await tx<{ public_key: string; wo_status: string; wo_status_effective: string; project_key: string; membership_level: string | null; hours_total: string }[]>`
          select public_key, wo_status, wo_status_effective, project_key, membership_level, hours_total
          from public.v_work_orders where tenant_id = public.app_tenant_id()`,
        board: await tx<{ s: string; n: string }[]>`
          select wo_status_effective as s, count(*)::text as n from public.v_work_order_board
          where tenant_id = public.app_tenant_id() group by 1 order by 1`,
        mismatch: await tx<{ n: string }[]>`
          select count(*)::text as n from public.v_work_order_board
          where tenant_id = public.app_tenant_id() and wo_status <> wo_status_effective`,
        vocab: await tx<{ code: string }[]>`
          select code from public.status_vocab where tenant_id = public.app_tenant_id() and domain = 'wo_status'`,
        items: await tx<{ status: string }[]>`select distinct status from public.v_items where tenant_id = public.app_tenant_id()`,
      }),
      { sql: api }
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(24);
    const codes = new Set(r.vocab.map((v) => v.code));
    for (const row of r.rows) {
      expect(row.public_key).toMatch(/^GS-10[1-8]-WO-\d{4}-\d{4}$/);
      expect(row.public_key.startsWith(row.project_key + "-WO-")).toBe(true);
      expect(row.wo_status).toBeTruthy();
      expect(codes.has(row.wo_status)).toBe(true);
    }
    // the stored status and the derived (visits + lifecycle) status agree for every seeded WO
    expect(Number(r.mismatch[0].n)).toBe(0);
    const states = r.board.map((b) => b.s).sort();
    expect(states).toEqual(
      ["Active Monitoring", "Closed", "Needs Reschedule", "Not Scheduled", "On Hold", "Ready for Billing", "Scheduled", "Waiting Payment"].sort()
    );
    for (const b of r.board) expect(Number(b.n)).toBeGreaterThan(0);
    // membership levels and hours are filled on the list path (§8.5)
    expect(r.rows.some((x) => x.membership_level === "Elite")).toBe(true);
    expect(r.rows.some((x) => Number(x.hours_total) > 0)).toBe(true);
    // items span more than one state, including an installed one
    expect(r.items.length).toBeGreaterThanOrEqual(6);
    expect(r.items.map((i) => i.status)).toContain("Installed (From Stock)");
  });

  it("custom fields: field_definitions exist and matching custom values are set on some rows", async () => {
    const r = await withTenantRead(
      env,
      SANDBOX_TENANT,
      async (tx) => ({
        defs: await tx<{ entity: string; key: string; type: string }[]>`
          select entity, key, type from public.field_definitions where tenant_id = public.app_tenant_id() order by entity, key`,
        po: await tx<{ n: string }[]>`select count(*)::text as n from public.work_orders where tenant_id = public.app_tenant_id() and custom ? 'po_number'`,
        warranty: await tx<{ v: string }[]>`select distinct custom->>'warranty' as v from public.work_orders where tenant_id = public.app_tenant_id() and custom ? 'warranty' order by 1`,
        pref: await tx<{ v: string }[]>`select distinct custom->>'preferred_contact' as v from public.contacts where tenant_id = public.app_tenant_id() and custom ? 'preferred_contact' order by 1`,
      }),
      { sql: api }
    );
    expect(r.defs).toEqual([
      { entity: "contacts", key: "preferred_contact", type: "picklist" },
      { entity: "work_orders", key: "po_number", type: "text" },
      { entity: "work_orders", key: "warranty", type: "picklist" },
    ]);
    expect(Number(r.po[0].n)).toBeGreaterThanOrEqual(3);
    expect(r.warranty.map((x) => x.v)).toEqual(["No", "Partial", "Yes"]);
    expect(r.pref.map((x) => x.v)).toEqual(["Email", "Phone", "Text"]);
  });

  it("minting a live WO key for GS-101 continues after the seeded numbers", async () => {
    const maxSeq = await withTenantRead(
      env,
      SANDBOX_TENANT,
      (tx) => tx<{ m: number }[]>`select max(wo_seq) as m from public.work_orders where tenant_id = public.app_tenant_id()`,
      { sql: api }
    );
    const minted = await withTenant(
      env,
      SANDBOX_TENANT,
      async (tx) => {
        const rows = await tx<{ public_key: string; seq: number; year: number }[]>`
          select public_key, seq, year from public.mint_public_key_parts(public.app_tenant_id(), 'work_order', 'GS-101')`;
        // do not keep the number — the seed's counter is asserted again after the reset below
        throw new Rollback(rows[0]);
      },
      { sql: api }
    ).catch((e: unknown) => {
      if (e instanceof Rollback) return e.row as { public_key: string; seq: number; year: number };
      throw e;
    });
    expect(Number(minted.seq)).toBeGreaterThan(Number(maxSeq[0].m));
    expect(minted.public_key).toBe(`GS-101-WO-${minted.year}-${String(minted.seq).padStart(4, "0")}`);
  });

  it("re-running 0003 is idempotent (counts unchanged) and the FHI tenant is untouched", async () => {
    await seedSandbox(admin, seedSql);
    expect(await sandboxCounts(admin)).toEqual(counts);
    expect(await fhiCounts(env, api)).toEqual(fhiBefore);
  });

  it("reset-sandbox wipes every sandbox row to 0 (events included) and reseeds to the same counts", async () => {
    const wiped = await wipeSandbox(admin);
    expect(wiped.total).toBeGreaterThan(0);
    const empty = await sandboxCounts(admin);
    for (const [table, n] of Object.entries(empty)) expect([table, n]).toEqual([table, 0]);

    const after = await resetSandbox(admin);
    expect(after.wiped.total).toBe(0);
    expect(after.counts).toEqual(counts);
    expect(await fhiCounts(env, api)).toEqual(fhiBefore);
  }, 60_000);
});
