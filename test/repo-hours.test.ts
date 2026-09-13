//==============================================================================
// repo-hours.test.ts — the per-WO hours log on Postgres (F3): shadow WO rows,
// index → position semantics, totals from v_work_order_hours, events.
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createScratchTenant, countEvents, dbAvailable, sharedSql, testEnv } from "./_pg";
import { withTenantRead, type Sql } from "../src/db";
import type { Env } from "../src/types";
import * as hours from "../src/repo/hours";
import type { WoRef } from "../src/repo/_shared";
import { normalizeEntryDateToIso } from "../src/time";

const up = await dbAvailable();

const REF: WoRef = {
  actionTaskId: "T-ACTION-1",
  zohoProjectId: "ZP-1",
  projectKey: "FHI-672",
  projectName: "Acme, John - 123 Main St - SERVICE",
  client: "Acme, John",
  workOrderNumber: "FHI-672-WO-2026-0007",
  subject: "Fix pool light",
};

describe("normalizeEntryDateToIso (pure)", () => {
  it("YYYY-MM-DD → midnight America/New_York (EDT in July, EST in January)", () => {
    expect(normalizeEntryDateToIso("2026-07-04")).toBe("2026-07-04T04:00:00.000Z");
    expect(normalizeEntryDateToIso("2026-01-15")).toBe("2026-01-15T05:00:00.000Z");
  });
  it("ISO instants pass through; garbage → null", () => {
    expect(normalizeEntryDateToIso("2026-07-04T10:30:00Z")).toBe("2026-07-04T10:30:00.000Z");
    expect(normalizeEntryDateToIso("nope")).toBeNull();
    expect(normalizeEntryDateToIso("")).toBeNull();
  });
});

describe.skipIf(!up)("repo/hours (Postgres)", () => {
  let sql: Sql;
  let env: Env;
  let tenant: string;

  beforeAll(async () => {
    sql = sharedSql();
    tenant = await createScratchTenant(testEnv(), sql, "hours");
    env = testEnv({ TENANT_ID: tenant });
  });
  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  it("unknown WO reads as { total: 0, entries: [] } (a KV miss)", async () => {
    expect(await hours.getHours(env, "never-seen")).toEqual({ total: 0, entries: [] });
    expect(await hours.editHoursEntry(env, "never-seen", 0, { hours: 1 })).toBeNull();
    expect(await hours.deleteHoursEntry(env, "never-seen", 0)).toBeNull();
  });

  it("first append creates the shadow project + WO (external_ids) and returns the exact entry shape", async () => {
    const h = await hours.appendHoursEntry(env, REF, { tech: "bob@example.com", hours: 1.5, at: "2026-07-04", note: "first" });
    expect(h.total).toBe(1.5);
    expect(h.entries).toHaveLength(1);
    expect(Object.keys(h.entries[0])).toEqual(["tech", "hours", "at", "note"]);
    expect(h.entries[0]).toEqual({ tech: "bob@example.com", hours: 1.5, at: "2026-07-04T04:00:00.000Z", note: "first" });

    const shadow = await withTenantRead(env, tenant, async (tx) => {
      const wo = await tx<{ public_key: string; wo_year: number; wo_seq: number; subject: string; custom: Record<string, unknown> }[]>`
        select w.public_key, w.wo_year, w.wo_seq, w.subject, w.custom from public.work_orders w
        join public.external_ids x on x.entity = 'work_order' and x.entity_id = w.id
        where x.system = 'zoho_projects_task_action' and x.external_id = ${REF.actionTaskId}`;
      const pr = await tx<{ public_key: string; name: string }[]>`
        select p.public_key, p.name from public.projects p
        join public.external_ids x on x.entity = 'project' and x.entity_id = p.id
        where x.system = 'zoho_projects_project' and x.external_id = ${REF.zohoProjectId}`;
      return { wo: wo[0], pr: pr[0] };
    }, { sql });
    expect(shadow.wo).toMatchObject({ public_key: REF.workOrderNumber, wo_year: 2026, wo_seq: 7, subject: "Fix pool light", custom: { _shadow: "f3" } });
    expect(shadow.pr).toMatchObject({ public_key: "FHI-672", name: REF.projectName });
    expect(await countEvents(env, sql, tenant, "hours_entry.logged")).toBe(1);
  });

  it("total is round(sum, 2) from the view; entries keep insertion order (position)", async () => {
    await hours.appendHoursEntry(env, REF, { tech: null, hours: 0.33 });
    await hours.appendHoursEntry(env, REF, { tech: "alice@example.com", hours: 2.005, note: null });
    const h = await hours.getHours(env, REF.actionTaskId);
    expect(h.entries.map((e) => e.hours)).toEqual([1.5, 0.33, 2.01]); // numeric(6,2) storage rounds 2.005 → 2.01
    expect(h.total).toBe(3.84);
    expect(h.entries[1]).toMatchObject({ tech: null, note: null });
  });

  it("edit by index patches only the given fields", async () => {
    const h = await hours.editHoursEntry(env, REF.actionTaskId, 1, { note: "lunch", hours: 0.5 });
    expect(h!.entries[1]).toMatchObject({ tech: null, hours: 0.5, note: "lunch" });
    expect(h!.total).toBe(4.01);
    expect(await hours.editHoursEntry(env, REF.actionTaskId, 3, { hours: 1 })).toBeNull();
    expect(await hours.editHoursEntry(env, REF.actionTaskId, -1, { hours: 1 })).toBeNull();
  });

  it("delete by index re-packs positions so later indexes shift down", async () => {
    const h = await hours.deleteHoursEntry(env, REF.actionTaskId, 0);
    expect(h!.entries.map((e) => e.hours)).toEqual([0.5, 2.01]);
    expect(h!.total).toBe(2.51);
    const positions = await withTenantRead(env, tenant, (tx) => tx<{ position: number }[]>`
      select h.position from public.hours_entries h
      join public.external_ids x on x.entity = 'work_order' and x.entity_id = h.work_order_id
      where x.external_id = ${REF.actionTaskId} order by h.position`, { sql });
    expect(positions.map((p) => p.position)).toEqual([0, 1]);
    // a further append lands at the end
    const h2 = await hours.appendHoursEntry(env, REF, { tech: "x@y.z", hours: 1 });
    expect(h2.entries.map((e) => e.hours)).toEqual([0.5, 2.01, 1]);
    expect(await countEvents(env, sql, tenant, "hours_entry.deleted")).toBe(1);
  });

  it("a second WO under the same project reuses the shadow project row", async () => {
    await hours.appendHoursEntry(env, { ...REF, actionTaskId: "T-ACTION-2", workOrderNumber: "FHI-672-WO-2026-0008" }, { hours: 1 });
    const n = await withTenantRead(env, tenant, (tx) => tx<{ n: string }[]>`
      select count(*)::text as n from public.projects where tenant_id = public.app_tenant_id() and public_key = 'FHI-672'`, { sql });
    expect(Number(n[0].n)).toBe(1);
    expect((await hours.getHours(env, "T-ACTION-2")).total).toBe(1);
    expect((await hours.getHours(env, REF.actionTaskId)).total).toBe(3.51);
  });
});
