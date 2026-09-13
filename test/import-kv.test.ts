//==============================================================================
// import-kv.test.ts — scripts/import-kv.ts against a fixture dump (F3).
// Fixture: 2 techs, 3 people (one sharing a technician's email), 6 hours
// entries across 2 WOs, 2 daily-report days with entries (+1 sent with a PDF),
// a reminder, admin config, a WO counter of 41, cache + unknown keys.
// Runs the loader TWICE and asserts counts, idempotency, sequences.next == 42,
// and that events were appended (and not duplicated by the re-run).
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createScratchTenant, countEvents, dbAvailable, sharedSql, testEnv } from "./_pg";
import { withTenantRead, type Sql } from "../src/db";
import type { Env } from "../src/types";
import { classifyKey, importDump, type ImportSummary, type KvDump } from "../scripts/import-kv";
import * as techs from "../src/repo/technicians";
import * as people from "../src/repo/people";
import * as hours from "../src/repo/hours";
import * as dr from "../src/repo/daily-reports";
import { getReminder } from "../src/reminders";
import { getAdminConfig } from "../src/admin";
import { mintWorkOrderNumber } from "../src/wonumber";

const up = await dbAvailable();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/kv-dump.fixture.json", import.meta.url), "utf8")) as KvDump;

describe("classifyKey (pure) — the WO_KV inventory", () => {
  it("maps every key family", () => {
    expect(classifyKey("technicians").kind).toBe("technicians");
    expect(classifyKey("people").kind).toBe("people");
    expect(classifyKey("admin:config").kind).toBe("admin_config");
    expect(classifyKey("hours:T1")).toEqual({ kind: "hours", parts: ["T1"] });
    expect(classifyKey("billable:T1")).toEqual({ kind: "billable", parts: ["T1"] });
    expect(classifyKey("dailyreport:T1:2026-09-01")).toEqual({ kind: "dailyreport_entries", parts: ["T1", "2026-09-01"] });
    expect(classifyKey("dailyreport-days:T1")).toEqual({ kind: "dailyreport_days", parts: ["T1"] });
    expect(classifyKey("dailyreport-sent:T1:cumulative")).toEqual({ kind: "dailyreport_sent", parts: ["T1", "cumulative"] });
    expect(classifyKey("dailyreport-pdf:T1:2026-09-01").kind).toBe("dailyreport_pdf");
    expect(classifyKey("reminder:I-1")).toEqual({ kind: "reminder", parts: ["I-1"] });
    expect(classifyKey("wo_seq:2026:__global__")).toEqual({ kind: "wo_seq", parts: ["2026", "__global__"] });
    expect(classifyKey("wo_seq:2026:FHI-672").parts).toEqual(["2026", "FHI-672"]);
    for (const k of ["zoho_creds", "google_creds", "zoho_scopes", "google_pending"]) expect(classifyKey(k).kind).toBe(k);
    for (const k of ["proj:search:svc:", "proj:detail:1", "tasks:woTagged", "ai:agg:open"]) expect(classifyKey(k).kind).toBe("cache");
    expect(classifyKey("something:new").kind).toBe("unknown");
  });
});

describe.skipIf(!up)("scripts/import-kv.ts importDump (Postgres)", () => {
  let sql: Sql;
  let env: Env;
  let tenant: string;
  let first: ImportSummary;
  let second: ImportSummary;
  let eventsAfterFirst = 0;

  beforeAll(async () => {
    sql = sharedSql();
    tenant = await createScratchTenant(testEnv(), sql, "import");
    env = testEnv({ TENANT_ID: tenant, PUBLIC_WORKER_URL: "https://api.example.test" });
  });
  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  it("dry run writes nothing", async () => {
    const dry = await importDump(fixture, { env, sql, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.errors).toEqual([]);
    expect(dry.objects.technicians.created).toBe(2);
    expect(await techs.listTechnicians(env)).toEqual([]);
    expect(await countEvents(env, sql, tenant)).toBe(0);
  });

  it("first run: counts per object, no errors, unknown/cache keys reported", async () => {
    first = await importDump(fixture, { env, sql });
    expect(first.errors).toEqual([]);
    expect(first.keysSeen).toBe(Object.keys(fixture.keys).length);
    expect(first.objects.technicians).toMatchObject({ created: 2, errors: 0 });
    // 3 people: Angie + Craig created; "Bob (person)" merged into technician Bob by email
    expect(first.objects.people).toMatchObject({ created: 2, updated: 1, errors: 0 });
    expect(first.objects.hours_entries).toMatchObject({ created: 6, updated: 0, errors: 0 });
    expect(first.objects.daily_report_days).toMatchObject({ created: 3, errors: 0 });
    expect(first.objects.daily_report_entries).toMatchObject({ created: 4, updated: 0, errors: 0 });
    expect(first.objects.daily_report_sent).toMatchObject({ created: 1 });
    expect(first.objects.daily_report_pdfs).toMatchObject({ created: 1 });
    expect(first.objects.reminders).toMatchObject({ created: 1 });
    expect(first.objects.admin_config).toMatchObject({ updated: 1 });
    expect(first.objects.wo_seq).toMatchObject({ updated: 1 });
    expect(first.objects.legacy_billable).toMatchObject({ created: 1, skipped: 1 });
    expect(first.objects.zoho_scopes).toMatchObject({ updated: 1 });
    expect(first.objects.google_pending).toMatchObject({ skipped: 1 });
    expect(first.objects.cache_keys.skipped).toBe(3);
    expect(first.unknownKeys).toEqual(["something:new"]);
    expect(first.sequences).toEqual({ "work_order/global/2026": 42 });
    eventsAfterFirst = await countEvents(env, sql, tenant);
    expect(eventsAfterFirst).toBeGreaterThan(10);
  });

  it("technicians keep their legacy ids; people merged by email; admin config normalized", async () => {
    const list = await techs.listTechnicians(env);
    expect(list.map((t) => [t.name, t.email, t.active])).toEqual([
      ["Alice Amp", "alice@example.com", false],
      ["Bob Builder", "bob@example.com", true],
    ]);
    // Legacy KV ids are kept as users.id — unless the uuid is already taken (users.id is a
    // GLOBAL primary key; a previous run of this suite left them under another scratch
    // tenant), in which case the loader assigns a fresh id and says so.
    const reassigned = (label: string) => first.notes.some((n) => n.startsWith(label) && n.includes("already in use"));
    if (!reassigned("technician alice@example.com")) expect(list[0].id).toBe("0f9d1c2a-1111-4c1b-9a1e-000000000002");
    if (!reassigned("technician bob@example.com")) expect(list[1].id).toBe("0f9d1c2a-1111-4c1b-9a1e-000000000001");
    const all = await people.getPeople(env);
    expect(all.map((p) => p.name)).toEqual(["Alice Amp", "Angie Hartman", "Bob Builder", "Craig"]);
    const angie = all.find((p) => p.name === "Angie Hartman")!;
    expect(angie).toMatchObject({ email: "", zohoUser: "Angie H" });
    if (!reassigned("person Angie Hartman")) expect(angie.id).toBe("0f9d1c2a-2222-4c1b-9a1e-000000000001");
    // the legacy id is always recorded in external_ids for traceability
    const links = await withTenantRead(env, tenant, (tx) => tx<{ system: string; external_id: string }[]>`
      select system, external_id from public.external_ids where tenant_id = public.app_tenant_id() and entity = 'user' order by system, external_id`, { sql });
    expect(links).toEqual([
      { system: "legacy_kv_person", external_id: "0f9d1c2a-2222-4c1b-9a1e-000000000001" },
      { system: "legacy_kv_person", external_id: "0f9d1c2a-2222-4c1b-9a1e-000000000002" },
      { system: "legacy_kv_person", external_id: "0f9d1c2a-2222-4c1b-9a1e-000000000003" },
      { system: "legacy_kv_technician", external_id: "0f9d1c2a-1111-4c1b-9a1e-000000000001" },
      { system: "legacy_kv_technician", external_id: "0f9d1c2a-1111-4c1b-9a1e-000000000002" },
    ]);
    const cfg = await getAdminConfig(env);
    expect(cfg).toEqual({ reportAccess: ["craig@fhiflorida.com", "angie@fhiflorida.com"], zohoUserOptions: ["Craig", "Angie H"], schedulingConfirmer: "Angie Hartman" });
  });

  it("hours / daily reports / reminder read back through the repos with the wire shapes", async () => {
    const h1 = await hours.getHours(env, "T1001");
    expect(h1.total).toBe(6.75);
    expect(h1.entries.map((e) => e.hours)).toEqual([2, 1.5, 0.25, 3]);
    expect(h1.entries[1].at).toBe("2026-09-01T04:00:00.000Z"); // bare date → midnight ET
    expect((await hours.getHours(env, "T1002")).total).toBe(4.5);

    expect(await dr.listDailyReportDaysEnriched(env, "T1001")).toEqual([
      { date: "2026-09-01", entries: 2, sent: true, pdfUrl: "https://api.example.test/work-orders/T1001/daily-report/2026-09-01/pdf" },
      { date: "2026-09-02", entries: 1, sent: false, pdfUrl: null },
    ]);
    const pdf = await dr.getPdf(env, "T1001", "2026-09-01");
    expect(new TextDecoder().decode(pdf!.bytes)).toBe("%PDF-1.4 fixture");
    expect(pdf!.woNumber).toBe("FHI-672-WO-2026-0017");
    expect((await dr.getDailyReport(env, "T1002", "2026-09-04")).entries[0].text).toBe("Swapped keypad");

    const r = await getReminder(env, "I-500");
    expect(r).toEqual({
      issueId: "I-500",
      projectId: "ZP-1",
      projectName: "Acme, John - 123 Main St - SERVICE",
      title: "Order the bracket",
      assigneeName: "Angie Hartman",
      remindAt: "2026-09-20T13:00:00.000Z",
      message: "before the trim visit",
      fired: false,
      createdAt: "2026-09-10T10:00:00.000Z",
    });
  });

  it("sequences: next == 42 and the next mint is 0042", async () => {
    const rows = await withTenantRead(env, tenant, (tx) => tx<{ next: number; scope_key: string; year: number }[]>`
      select next, scope_key, year from public.sequences where tenant_id = public.app_tenant_id() and kind = 'work_order'`, { sql });
    expect(rows).toEqual([{ next: 42, scope_key: "global", year: 2026 }]);
    const minted = await mintWorkOrderNumber(env, "FHI-672");
    expect(minted.seq).toBe(42);
    expect(minted.full).toMatch(/^FHI-672-WO-\d{4}-0042$/);
  });

  it("second run is idempotent: nothing duplicated, sequences stays put (mint advanced it to 43), events not re-appended", async () => {
    second = await importDump(fixture, { env, sql });
    expect(second.errors).toEqual([]);
    expect(second.objects.technicians).toMatchObject({ created: 0, unchanged: 2 });
    expect(second.objects.people).toMatchObject({ created: 0 });
    expect(second.objects.hours_entries).toMatchObject({ created: 0, updated: 6 });
    expect(second.objects.daily_report_entries).toMatchObject({ created: 0, updated: 4 });
    expect(second.objects.daily_report_days.created).toBe(0);
    expect(second.sequences).toEqual({ "work_order/global/2026": 43 }); // greatest(existing, 42)
    expect(second.notes.some((n) => n.includes("kept the higher value"))).toBe(true);

    expect((await techs.listTechnicians(env)).length).toBe(2);
    expect((await people.getPeople(env)).length).toBe(4);
    expect((await hours.getHours(env, "T1001")).entries.length).toBe(4);
    expect((await dr.getDailyReport(env, "T1001", "2026-09-01")).entries.length).toBe(2);
    const files = await withTenantRead(env, tenant, (tx) => tx<{ n: string }[]>`select count(*)::text as n from public.files where tenant_id = public.app_tenant_id()`, { sql });
    expect(Number(files[0].n)).toBe(1);
    const wos = await withTenantRead(env, tenant, (tx) => tx<{ n: string }[]>`select count(*)::text as n from public.work_orders where tenant_id = public.app_tenant_id()`, { sql });
    expect(Number(wos[0].n)).toBe(2);

    // Idempotency keys: the re-run appended no import events (only the mint above wrote nothing to events).
    expect(await countEvents(env, sql, tenant)).toBe(eventsAfterFirst);
  });
});
