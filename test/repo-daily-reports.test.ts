//==============================================================================
// repo-daily-reports.test.ts — daily-report days / entries / sent / PDF on
// Postgres (F3): wire shapes, index → position, cumulative pseudo-day, files.
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createScratchTenant, countEvents, dbAvailable, sharedSql, testEnv } from "./_pg";
import { withTenantRead, type Sql } from "../src/db";
import type { Env } from "../src/types";
import * as dr from "../src/repo/daily-reports";
import type { WoRef } from "../src/repo/_shared";

const up = await dbAvailable();

const REF: WoRef = {
  actionTaskId: "T-DR-1",
  zohoProjectId: "ZP-9",
  projectKey: "FHI-900",
  projectName: "Smith, Jane - 9 Elm - SERVICE",
  client: "Smith, Jane",
  workOrderNumber: "FHI-900-WO-2026-0003",
  subject: "Camera swap",
};

describe.skipIf(!up)("repo/daily-reports (Postgres)", () => {
  let sql: Sql;
  let env: Env;
  let tenant: string;

  beforeAll(async () => {
    sql = sharedSql();
    tenant = await createScratchTenant(testEnv(), sql, "daily");
    env = testEnv({ TENANT_ID: tenant, PUBLIC_WORKER_URL: "https://api.example.test" });
  });
  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  it("unknown WO: empty day, no days, no pdf, edit/delete → null", async () => {
    const day = await dr.getDailyReport(env, "nope", "2026-09-01");
    expect(day).toEqual({ date: "2026-09-01", entries: [], sent: false, pdfUrl: null });
    expect(Object.keys(day)).toEqual(["date", "entries", "sent", "pdfUrl"]);
    expect(await dr.listDailyReportDays(env, "nope")).toEqual({ days: [] });
    expect(await dr.listDailyReportDaysEnriched(env, "nope")).toEqual([]);
    expect(await dr.getPdf(env, "nope", "2026-09-01")).toBeNull();
    expect(await dr.editEntry(env, "nope", 0, "x", "2026-09-01")).toBeNull();
    expect(await dr.deleteEntry(env, "nope", 0, "2026-09-01")).toBeNull();
  });

  it("add entries on two days; entry shape {tech, text, at}; days index sorted", async () => {
    const d1 = await dr.addEntry(env, REF, { text: "Arrived on site", tech: "bob@example.com", date: "2026-09-02" });
    expect(d1.date).toBe("2026-09-02");
    expect(Object.keys(d1.entries[0])).toEqual(["tech", "text", "at"]);
    expect(d1.entries[0]).toMatchObject({ tech: "bob@example.com", text: "Arrived on site" });
    await dr.addEntry(env, REF, { text: "Replaced camera 2", date: "2026-09-02" });
    await dr.addEntry(env, REF, { text: "Earlier day note", date: "2026-09-01" });
    expect(await dr.listDailyReportDays(env, REF.actionTaskId)).toEqual({ days: ["2026-09-01", "2026-09-02"] });
    const enriched = await dr.listDailyReportDaysEnriched(env, REF.actionTaskId);
    expect(enriched).toEqual([
      { date: "2026-09-01", entries: 1, sent: false, pdfUrl: null },
      { date: "2026-09-02", entries: 2, sent: false, pdfUrl: null },
    ]);
    expect(await countEvents(env, sql, tenant, "daily_report.entry_added")).toBe(3);
  });

  it("date validation: bad date on write → DailyReportError; on read → empty", async () => {
    await expect(dr.addEntry(env, REF, { text: "x", date: "09/02/2026" })).rejects.toBeInstanceOf(dr.DailyReportError);
    expect((await dr.getDailyReport(env, REF.actionTaskId, "09/02/2026")).entries).toEqual([]);
  });

  it("edit and delete by index within the day; positions re-pack", async () => {
    const edited = await dr.editEntry(env, REF.actionTaskId, 1, "Replaced camera 2 (and 3)", "2026-09-02");
    expect(edited!.entries.map((e) => e.text)).toEqual(["Arrived on site", "Replaced camera 2 (and 3)"]);
    expect(await dr.editEntry(env, REF.actionTaskId, 5, "x", "2026-09-02")).toBeNull();
    await dr.addEntry(env, REF, { text: "third", date: "2026-09-02" });
    const after = await dr.deleteEntry(env, REF.actionTaskId, 0, "2026-09-02");
    expect(after!.entries.map((e) => e.text)).toEqual(["Replaced camera 2 (and 3)", "third"]);
    const again = await dr.editEntry(env, REF.actionTaskId, 1, "third!", "2026-09-02");
    expect(again!.entries[1].text).toBe("third!");
    // a day with all entries deleted still exists (entries: 0), like the old days index
    await dr.deleteEntry(env, REF.actionTaskId, 0, "2026-09-01");
    expect(await dr.listDailyReportDaysEnriched(env, REF.actionTaskId)).toEqual([
      { date: "2026-09-01", entries: 0, sent: false, pdfUrl: null },
      { date: "2026-09-02", entries: 2, sent: false, pdfUrl: null },
    ]);
    expect(await dr.entriesByDay(env, REF.actionTaskId)).toEqual([
      { date: "2026-09-02", entries: expect.arrayContaining([expect.objectContaining({ text: "third!" })]) },
    ]);
  });

  it("markSent stores the PDF (files.bytes) and derives sent/pdfUrl; re-send overwrites", async () => {
    const pdf1 = new TextEncoder().encode("%PDF-1.4 one");
    await dr.markSent(env, REF, "2026-09-02", pdf1, dr.pdfUrlFor(env, REF.actionTaskId, "2026-09-02"));
    const day = await dr.getDailyReport(env, REF.actionTaskId, "2026-09-02");
    expect(day.sent).toBe(true);
    expect(day.pdfUrl).toBe("https://api.example.test/work-orders/T-DR-1/daily-report/2026-09-02/pdf");
    const got = await dr.getPdf(env, REF.actionTaskId, "2026-09-02");
    expect(new TextDecoder().decode(got!.bytes)).toBe("%PDF-1.4 one");
    expect(got!.woNumber).toBe(REF.workOrderNumber);

    const pdf2 = new TextEncoder().encode("%PDF-1.4 two");
    await dr.markSent(env, REF, "2026-09-02", pdf2, null);
    expect(new TextDecoder().decode((await dr.getPdf(env, REF.actionTaskId, "2026-09-02"))!.bytes)).toBe("%PDF-1.4 two");
    const files = await withTenantRead(env, tenant, (tx) => tx<{ n: string }[]>`select count(*)::text as n from public.files where tenant_id = public.app_tenant_id() and entity = 'daily_report' and kind = 'daily_report_pdf'`, { sql });
    expect(Number(files[0].n)).toBe(1); // overwritten, not duplicated
    expect(await countEvents(env, sql, tenant, "daily_report.sent")).toBe(2);

    // pdfUrl is derived: without PUBLIC_WORKER_URL it is null even though sent
    expect((await dr.getDailyReport(testEnv({ TENANT_ID: tenant }), REF.actionTaskId, "2026-09-02")).pdfUrl).toBeNull();
    expect((await dr.listDailyReportDaysEnriched(env, REF.actionTaskId))[1]).toEqual({ date: "2026-09-02", entries: 2, sent: true, pdfUrl: day.pdfUrl });
  });

  it("cumulative = the report_date NULL row; never listed as a day", async () => {
    await dr.markSent(env, REF, dr.CUMULATIVE, new TextEncoder().encode("%PDF cumulative"), null);
    const cum = await dr.getDailyReport(env, REF.actionTaskId, dr.CUMULATIVE);
    expect(cum).toEqual({ date: "cumulative", entries: [], sent: true, pdfUrl: "https://api.example.test/work-orders/T-DR-1/daily-report/cumulative/pdf" });
    expect((await dr.getPdf(env, REF.actionTaskId, dr.CUMULATIVE))!.bytes.byteLength).toBeGreaterThan(0);
    expect(await dr.listDailyReportDays(env, REF.actionTaskId)).toEqual({ days: ["2026-09-01", "2026-09-02"] });
    const rows = await withTenantRead(env, tenant, (tx) => tx<{ n: string }[]>`select count(*)::text as n from public.daily_reports d join public.external_ids x on x.entity='work_order' and x.entity_id = d.work_order_id where x.external_id = ${REF.actionTaskId} and d.report_date is null`, { sql });
    expect(Number(rows[0].n)).toBe(1);
  });
});
