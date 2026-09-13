//==============================================================================
// db.test.ts — db.ts: connection fallback, SET LOCAL tenant binding, read-only
// transactions, and TENANT ISOLATION UNDER CONCURRENCY (two tenants, 50
// interleaved transactions, no cross-reads). Skips when no Postgres is up.
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbHealth, getSql, withTenant, withTenantRead, isUuid, DbError, type Sql } from "../src/db";
import { resolveTenant, TenantError } from "../src/tenant";
import { dbAvailable, testEnv, createScratchTenant, FHI_TENANT, sharedSql } from "./_pg";

const up = await dbAvailable();

describe("db.ts (no database needed)", () => {
  it("isUuid accepts v4/v7 and rejects junk", () => {
    expect(isUuid(FHI_TENANT)).toBe(true);
    expect(isUuid("0192b5a1-7c3e-7c3a-8f1a-1234567890ab")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("f4100000-0000-4000-8000-00000000000'; drop table x;--")).toBe(false);
  });

  it("withTenant refuses a non-UUID tenant before touching the DB", async () => {
    const env = testEnv({ DATABASE_URL: "postgres://nobody@127.0.0.1:1/nope" });
    await expect(withTenant(env, "bad", async () => 1)).rejects.toBeInstanceOf(DbError);
  });

  it("dbHealth reports 'none' when nothing is configured", async () => {
    const h = await dbHealth(testEnv({ DATABASE_URL: undefined }));
    expect(h).toMatchObject({ ok: false, via: "none" });
  });

  it("resolveTenant uses env by default and the header only when allowed", async () => {
    const req = new Request("https://x/health", { headers: { "X-Tenant-Id": "0192b5a1-7c3e-7c3a-8f1a-1234567890ab" } });
    expect(await resolveTenant(req, testEnv())).toEqual({ tenantId: FHI_TENANT, source: "env" });
    expect(await resolveTenant(req, testEnv({ ALLOW_TENANT_HEADER: "true" }))).toEqual({
      tenantId: "0192b5a1-7c3e-7c3a-8f1a-1234567890ab",
      source: "header",
    });
    await expect(resolveTenant(req, testEnv({ TENANT_ID: "" }))).rejects.toBeInstanceOf(TenantError);
    const badHeader = new Request("https://x/health", { headers: { "X-Tenant-Id": "nope" } });
    await expect(resolveTenant(badHeader, testEnv({ ALLOW_TENANT_HEADER: "true" }))).rejects.toMatchObject({ status: 400 });
  });
});

describe.skipIf(!up)("db.ts against Postgres", () => {
  const env = testEnv();
  let sql: Sql;
  let tenantB: string;

  beforeAll(async () => {
    sql = sharedSql(8);
    tenantB = await createScratchTenant(env, sql, "isolation-B");
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("dbHealth is ok via DATABASE_URL", async () => {
    const h = await dbHealth(env);
    expect(h.ok).toBe(true);
    expect(h.via).toBe("database_url");
  });

  it("getSql builds a working per-request client", async () => {
    const s = getSql(env);
    try {
      const rows = await s`select current_user as u`;
      expect(typeof rows[0].u).toBe("string");
    } finally {
      await s.end({ timeout: 5 });
    }
  });

  it("withTenant binds app.tenant_id for the transaction only", async () => {
    const inside = await withTenant(env, FHI_TENANT, async (tx) => {
      const r = await tx<{ t: string | null; f: string | null }[]>`
        select current_setting('app.tenant_id', true) as t, public.app_tenant_id()::text as f`;
      return r[0];
    }, { sql });
    expect(inside.t).toBe(FHI_TENANT);
    expect(inside.f).toBe(FHI_TENANT);
    // Outside any transaction the GUC is unset on that connection (SET LOCAL died with the tx).
    const outside = await sql<{ t: string | null }[]>`select nullif(current_setting('app.tenant_id', true), '') as t`;
    expect(outside[0].t).toBeNull();
  });

  it("withTenant rolls back when the callback throws", async () => {
    const key = `test.rollback.${crypto.randomUUID()}`;
    await expect(
      withTenant(env, FHI_TENANT, async (tx) => {
        await tx`insert into public.tenant_settings (tenant_id, key, value) values (public.app_tenant_id(), ${key}, '1'::jsonb)`;
        throw new Error("boom");
      }, { sql })
    ).rejects.toThrow("boom");
    const rows = await withTenantRead(env, FHI_TENANT, (tx) => tx`select 1 from public.tenant_settings where key = ${key}`, { sql });
    expect(rows.length).toBe(0);
  });

  it("withTenantRead refuses writes", async () => {
    await expect(
      withTenantRead(env, FHI_TENANT, async (tx) => {
        await tx`insert into public.tenant_settings (tenant_id, key, value) values (public.app_tenant_id(), 'test.ro', '1'::jsonb)`;
      }, { sql })
    ).rejects.toMatchObject({ code: "25006" }); // read_only_sql_transaction
  });

  it("isolates two tenants across 50 interleaved transactions (no cross-reads)", async () => {
    const A = FHI_TENANT;
    const B = tenantB;
    const tag = crypto.randomUUID().slice(0, 8);

    // A gets 2 scratch projects, B gets 3 — counts differ so a leak is visible.
    const seed = async (tenant: string, n: number) =>
      withTenant(env, tenant, async (tx) => {
        for (let i = 0; i < n; i++) {
          await tx`insert into public.projects (tenant_id, public_key, name)
                   values (public.app_tenant_id(), ${`ISO-${tag}-${tenant.slice(0, 4)}-${i}`}, ${`iso ${tag} ${i}`})`;
        }
      }, { sql });
    await seed(A, 2);
    await seed(B, 3);

    const countFor = async (tenant: string) =>
      withTenantRead(env, tenant, async (tx) => {
        const r = await tx<{ n: string }[]>`select count(*)::text as n from public.projects where public_key like ${`ISO-${tag}-%`}`;
        return Number(r[0].n);
      }, { sql });
    const expectA = await countFor(A);
    const expectB = await countFor(B);
    expect(expectA).toBe(2);
    expect(expectB).toBe(3);

    // 50 interleaved transactions, alternating tenants, all in flight at once over a
    // pooled client (max 8) so connections are reused across tenants — exactly the
    // Hyperdrive situation SET LOCAL must survive.
    const runs = Array.from({ length: 50 }, (_, i) => {
      const tenant = i % 2 === 0 ? A : B;
      return withTenant(env, tenant, async (tx) => {
        const g = await tx<{ t: string }[]>`select current_setting('app.tenant_id', true) as t`;
        // A little jitter so transactions genuinely overlap.
        await tx`select pg_sleep(${Math.random() * 0.02})`;
        const c = await tx<{ n: string }[]>`select count(*)::text as n from public.projects where public_key like ${`ISO-${tag}-%`}`;
        const leak = await tx<{ n: string }[]>`select count(*)::text as n from public.projects where tenant_id <> public.app_tenant_id()`;
        return { tenant, guc: g[0].t, count: Number(c[0].n), foreignRows: Number(leak[0].n) };
      }, { sql });
    });
    const results = await Promise.all(runs);

    for (const r of results) {
      expect(r.guc).toBe(r.tenant);
      expect(r.count).toBe(r.tenant === A ? expectA : expectB);
      expect(r.foreignRows).toBe(0); // RLS: rows of the other tenant are invisible
    }
    expect(results.filter((r) => r.tenant === A).length).toBe(25);
    expect(results.filter((r) => r.tenant === B).length).toBe(25);
  });

  it("a tenant cannot insert a row for another tenant (WITH CHECK)", async () => {
    await expect(
      withTenant(env, tenantB, async (tx) => {
        await tx`insert into public.projects (tenant_id, public_key, name) values (${FHI_TENANT}, ${`X-${crypto.randomUUID()}`}, 'leak')`;
      }, { sql })
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege (RLS)
  });
});
