//==============================================================================
// keys.test.ts — mintPublicKey over mint_public_key_parts(): the seeded
// work_order pattern yields FHI-672-WO-<year>-0001 then 0002, 200 concurrent
// mints are unique/gap-free, a rolled-back tx burns no number, and the other
// seeded kinds (project/deal) format as expected. Skips without Postgres.
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenant, withTenantRead, type Sql } from "../src/db";
import { mintPublicKey, mintPublicKeyString } from "../src/keys";
import { getNumbering, setNumbering } from "../src/settings";
import { dbAvailable, testEnv, createScratchTenant, sharedSql } from "./_pg";

const up = await dbAvailable();

describe.skipIf(!up)("keys.ts mintPublicKey", () => {
  const env = testEnv();
  let sql: Sql;
  let tenant: string;
  const year = new Date().getFullYear(); // tenant tz America/New_York; test host is close enough except at midnight NY

  beforeAll(async () => {
    sql = sharedSql(8);
    tenant = await createScratchTenant(env, sql, "keys");
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("uses the seeded numbering.work_order pattern", async () => {
    const cfg = await withTenantRead(env, tenant, (tx) => getNumbering(tx, "work_order"), { sql });
    expect(cfg).toEqual({ pattern: "{projectKey}-WO-{YYYY}-{seq4}", scope: "global", pad: 4, yearly_reset: true });
  });

  it("mints FHI-672-WO-<year>-0001 then 0002 (same MintedWo shape as wonumber.ts)", async () => {
    const first = await withTenant(env, tenant, (tx) => mintPublicKey(tx, "work_order", "FHI-672"), { sql });
    expect(first).toEqual({
      full: `FHI-672-WO-${year}-0001`,
      projectKey: "FHI-672",
      mintedRef: `${year}-0001`,
      year,
      seq: 1,
    });
    // Global scope: a different project shares the counter.
    const second = await withTenant(env, tenant, (tx) => mintPublicKey(tx, "work_order", "FHI-900"), { sql });
    expect(second.full).toBe(`FHI-900-WO-${year}-0002`);
    expect(second.mintedRef).toBe(`${year}-0002`);
    expect(second.seq).toBe(2);
  });

  it("does not burn a number when the transaction rolls back", async () => {
    await expect(
      withTenant(env, tenant, async (tx) => {
        await mintPublicKey(tx, "work_order", "FHI-672");
        throw new Error("abort");
      }, { sql })
    ).rejects.toThrow("abort");
    const next = await withTenant(env, tenant, (tx) => mintPublicKey(tx, "work_order", "FHI-672"), { sql });
    expect(next.seq).toBe(3);
  });

  it("200 concurrent mints are unique and gap-free", async () => {
    const before = 3;
    const minted = await Promise.all(
      Array.from({ length: 200 }, () =>
        withTenant(env, tenant, (tx) => mintPublicKey(tx, "work_order", "FHI-672"), { sql })
      )
    );
    const fulls = new Set(minted.map((m) => m.full));
    expect(fulls.size).toBe(200);
    const seqs = minted.map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs[0]).toBe(before + 1);
    expect(seqs[199]).toBe(before + 200);
    for (const m of minted) expect(m.full).toBe(`FHI-672-WO-${year}-${String(m.seq).padStart(4, "0")}`);

    const row = await withTenantRead(env, tenant, (tx) => tx<{ next: number }[]>`
      select next from public.sequences
      where tenant_id = public.app_tenant_id() and kind = 'work_order' and scope_key = 'global' and year = ${year}`, { sql });
    expect(row[0].next).toBe(before + 200 + 1);
  }, 30_000);

  it("formats the other seeded kinds and the string variant", async () => {
    const project = await withTenant(env, tenant, (tx) => mintPublicKey(tx, "project"), { sql });
    expect(project.full).toBe("FHI-1");
    expect(project.seq).toBe(1);
    expect(project.mintedRef).toBe(`${year}-1`);
    const deal = await withTenant(env, tenant, (tx) => mintPublicKeyString(tx, "deal"), { sql });
    expect(deal).toBe("FHI-D-1");
  });

  it("per_project scope keeps a counter per project key and requires one", async () => {
    await withTenant(env, tenant, (tx) =>
      setNumbering(tx, "work_order", { pattern: "{projectKey}-WO-{YYYY}-{seq4}", scope: "per_project", pad: 4, yearly_reset: true }), { sql });
    const a = await withTenant(env, tenant, (tx) => mintPublicKey(tx, "work_order", "FHI-111"), { sql });
    const b = await withTenant(env, tenant, (tx) => mintPublicKey(tx, "work_order", "FHI-222"), { sql });
    expect(a.full).toBe(`FHI-111-WO-${year}-0001`);
    expect(b.full).toBe(`FHI-222-WO-${year}-0001`);
    await expect(withTenant(env, tenant, (tx) => mintPublicKey(tx, "work_order"), { sql })).rejects.toThrow(/per_project/);
  });

  it("fails loudly for a kind with no numbering setting", async () => {
    await expect(withTenant(env, tenant, (tx) => mintPublicKey(tx, "widget"), { sql })).rejects.toThrow(/numbering\.widget/);
  });
});
