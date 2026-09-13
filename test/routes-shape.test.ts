//==============================================================================
// routes-shape.test.ts — the UI-contract invariant for the routes F3 moved
// from KV to Postgres. Calls the REAL router (src/index.ts) with the Zoho fake
// (test/_zoho-fake.ts) for the WO itself and the real Postgres repos for
// technicians / people / hours / daily reports, then asserts the JSON keys
// match data-model.md §4 EXACTLY (order included — the wire is the contract).
//==============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createScratchTenant, dbAvailable, sharedSql, testEnv } from "./_pg";
import type { Sql } from "../src/db";
import type { Env } from "../src/types";

vi.mock("../src/zoho", async () => (await import("./_zoho-fake")).zohoFake);
vi.mock("../src/calendar", () => ({
  CalendarError: class extends Error {},
  buildEventBody: () => ({}),
  insertEvent: async () => ({ id: "ev1", htmlLink: null }),
  patchEvent: async () => ({ id: "ev1", htmlLink: null }),
  deleteEvent: async () => {},
  listEvents: async () => [],
}));
vi.mock("../src/cliq", () => ({ postToCliq: async () => {} }));
vi.mock("../src/pdf", () => ({
  buildDailyReportPdf: () => new TextEncoder().encode("%PDF-1.4 test"),
  buildTextPdf: () => new TextEncoder().encode("%PDF-1.4 test"),
}));

import worker from "../src/index";
import { _clearCache } from "../src/cache";
import { reset as resetZoho } from "./_zoho-fake";

const up = await dbAvailable();

// data-model.md §4 — top-level keys exactly as today.
const TECHNICIAN_KEYS = ["id", "name", "email", "active", "createdAt", "updatedAt"];
const PERSON_KEYS = ["id", "name", "email", "active", "zohoUser", "createdAt", "updatedAt"];
const HOURS_ENTRY_KEYS = ["tech", "hours", "at", "note"];
const DAILY_ENTRY_KEYS = ["tech", "text", "at"];
const DAILY_DAY_KEYS = ["date", "entries", "sent", "pdfUrl"];
const DAYS_ROW_KEYS = ["date", "entries", "sent", "pdfUrl"];

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe.skipIf(!up)("route JSON shapes (Postgres-backed routes)", () => {
  let sql: Sql;
  let env: Env;
  let woId = "";

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; res: Response }> {
    const res = await worker.fetch(
      new Request(`https://api.test${path}`, {
        method,
        headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx
    );
    const ct = res.headers.get("Content-Type") ?? "";
    const json = ct.includes("application/json") ? await res.clone().json() : null;
    return { status: res.status, json, res };
  }

  beforeAll(async () => {
    sql = sharedSql();
    const tenant = await createScratchTenant(testEnv(), sql, "routes");
    env = testEnv({
      TENANT_ID: tenant,
      ZOHO_WO_FIELD: "work_order_hash",
      ZOHO_PORTAL_ID: "portal",
      ZOHO_PURCHASING_PROJECT_ID: "PURCH1",
      APP_ORIGIN: "https://app.example.com",
      WO_SEQUENCE_SCOPE: "global",
      PUBLIC_WORKER_URL: "https://api.test",
    });
    resetZoho();
    _clearCache();
    const created = await call("POST", "/work-orders", { projectId: "P1", subject: "Fix pool light" });
    expect(created.status).toBe(201);
    woId = created.json.id;
    expect(created.json.workOrderNumber).toMatch(/^FHI-672-WO-\d{4}-0001$/); // minted by Postgres
  });
  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });
  beforeEach(() => _clearCache());

  it("GET /technicians → {count, technicians:[Technician]}", async () => {
    const created = await call("POST", "/technicians", { name: "Bob Builder", email: "bob@example.com" });
    expect(created.status).toBe(201);
    expect(Object.keys(created.json)).toEqual(TECHNICIAN_KEYS);

    const r = await call("GET", "/technicians?active=true");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["count", "technicians"]);
    expect(r.json.count).toBe(1);
    expect(Object.keys(r.json.technicians[0])).toEqual(TECHNICIAN_KEYS);

    const patched = await call("PATCH", `/technicians/${created.json.id}`, { active: false });
    expect(patched.status).toBe(200);
    expect(Object.keys(patched.json)).toEqual(TECHNICIAN_KEYS);
    expect((await call("PATCH", `/technicians/${crypto.randomUUID()}`, { active: false })).status).toBe(404);
    const dup = await call("POST", "/technicians", { name: "B", email: "BOB@example.com" });
    expect(dup.status).toBe(400);
    expect(dup.json).toEqual({ error: "a technician with email bob@example.com already exists" });
  });

  it("GET /people → {count, people:[Person]}", async () => {
    const created = await call("POST", "/people", { name: "Angie", zohoUser: "Angie H" });
    expect(created.status).toBe(201);
    expect(Object.keys(created.json)).toEqual(PERSON_KEYS);
    expect(created.json.email).toBe("");

    const r = await call("GET", "/people?all=1");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["count", "people"]);
    for (const p of r.json.people) expect(Object.keys(p)).toEqual(PERSON_KEYS);
    // unified model: the (inactive) technician is a person too; the default list is active-only
    expect(r.json.count).toBe(2);
    expect((await call("GET", "/people")).json.count).toBe(1);
    const patched = await call("PATCH", `/people/${created.json.id}`, { email: "angie@example.com" });
    expect(Object.keys(patched.json)).toEqual(PERSON_KEYS);
  });

  it("hours routes return the WorkOrder with hours {total, entries[{tech,hours,at,note}]}", async () => {
    const logged = await call("POST", `/work-orders/${woId}/hours`, { hours: 1.5, techEmail: "bob@example.com", note: "n", date: "2026-09-01" });
    expect(logged.status).toBe(200);
    expect(Object.keys(logged.json.hours)).toEqual(["total", "entries"]);
    expect(Object.keys(logged.json.hours.entries[0])).toEqual(HOURS_ENTRY_KEYS);
    expect(logged.json.hours).toEqual({ total: 1.5, entries: [{ tech: "bob@example.com", hours: 1.5, at: "2026-09-01T04:00:00.000Z", note: "n" }] });

    await call("POST", `/work-orders/${woId}/hours`, { hours: 2 });
    const edited = await call("PATCH", `/work-orders/${woId}/hours`, { index: 1, note: "edited" });
    expect(edited.status).toBe(200);
    expect(edited.json.hours.entries[1]).toEqual({ tech: null, hours: 2, at: expect.any(String), note: "edited" });
    expect(edited.json.hours.total).toBe(3.5);

    const bad = await call("PATCH", `/work-orders/${woId}/hours`, { index: 9, note: "x" });
    expect(bad.status).toBe(404);
    expect(bad.json).toEqual({ error: "work order or hours entry not found" });

    const deleted = await call("DELETE", `/work-orders/${woId}/hours?index=0`);
    expect(deleted.status).toBe(200);
    expect(deleted.json.hours).toEqual({ total: 2, entries: [{ tech: null, hours: 2, at: expect.any(String), note: "edited" }] });

    // GET /work-orders/:id (DETAIL) hydrates the same hours from Postgres
    const detail = await call("GET", `/work-orders/${woId}`);
    expect(detail.json.hours.total).toBe(2);
    expect((await call("POST", `/work-orders/nope/hours`, { hours: 1 })).status).toBe(404);
  });

  it("daily-report routes: entries / days / get / send / pdf shapes", async () => {
    const added = await call("POST", `/work-orders/${woId}/daily-report/entries`, { text: "Arrived", tech: "bob@example.com", date: "2026-09-02" });
    expect(added.status).toBe(201);
    expect(Object.keys(added.json)).toEqual(["date", "entries"]);
    expect(Object.keys(added.json.entries[0])).toEqual(DAILY_ENTRY_KEYS);
    await call("POST", `/work-orders/${woId}/daily-report/entries`, { text: "Second", date: "2026-09-02" });

    const edited = await call("PATCH", `/work-orders/${woId}/daily-report/entries`, { index: 1, text: "Second!", date: "2026-09-02" });
    expect(edited.status).toBe(200);
    expect(Object.keys(edited.json)).toEqual(["date", "entries"]);
    expect(edited.json.entries[1].text).toBe("Second!");
    expect((await call("PATCH", `/work-orders/${woId}/daily-report/entries`, { index: 5, text: "x", date: "2026-09-02" })).status).toBe(404);

    const days = await call("GET", `/work-orders/${woId}/daily-report/days`);
    expect(days.status).toBe(200);
    expect(Object.keys(days.json)).toEqual(["days"]);
    expect(Object.keys(days.json.days[0])).toEqual(DAYS_ROW_KEYS);
    expect(days.json.days).toEqual([{ date: "2026-09-02", entries: 2, sent: false, pdfUrl: null }]);

    const day = await call("GET", `/work-orders/${woId}/daily-report?date=2026-09-02`);
    expect(Object.keys(day.json)).toEqual(DAILY_DAY_KEYS);
    expect(day.json).toEqual({ date: "2026-09-02", entries: expect.any(Array), sent: false, pdfUrl: null });

    const empty = await call("POST", `/work-orders/${woId}/daily-report/send`, { date: "2026-09-03" });
    expect(empty.status).toBe(400);
    expect(empty.json).toEqual({ error: "no entries to send" });

    const sent = await call("POST", `/work-orders/${woId}/daily-report/send`, { date: "2026-09-02" });
    expect(sent.status).toBe(200);
    expect(Object.keys(sent.json)).toEqual(DAILY_DAY_KEYS);
    expect(sent.json.sent).toBe(true);
    expect(sent.json.pdfUrl).toBe(`https://api.test/work-orders/${woId}/daily-report/2026-09-02/pdf`);

    const pdf = await call("GET", `/work-orders/${woId}/daily-report/2026-09-02/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.res.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdf.res.headers.get("Content-Disposition")).toBe(`inline; filename="daily-report-FHI-672-WO-${new Date().getUTCFullYear()}-0001-2026-09-02.pdf"`);
    expect(new TextDecoder().decode(new Uint8Array(await pdf.res.arrayBuffer()))).toBe("%PDF-1.4 test");
    expect((await call("GET", `/work-orders/${woId}/daily-report/2026-09-03/pdf`)).status).toBe(404);

    const cumulative = await call("POST", `/work-orders/${woId}/daily-report/send`, { mode: "cumulative" });
    expect(cumulative.status).toBe(200);
    expect(cumulative.json).toEqual({ date: "cumulative", entries: expect.any(Array), sent: true, pdfUrl: `https://api.test/work-orders/${woId}/daily-report/cumulative/pdf` });
    expect((await call("GET", `/work-orders/${woId}/daily-report/cumulative/pdf`)).status).toBe(200);

    const removed = await call("DELETE", `/work-orders/${woId}/daily-report/entries?index=0&date=2026-09-02`);
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ date: "2026-09-02", entries: [expect.objectContaining({ text: "Second!" })] });
    expect((await call("GET", `/work-orders/${woId}/daily-report/days`)).json.days[0]).toEqual({ date: "2026-09-02", entries: 1, sent: true, pdfUrl: expect.any(String) });

    // unknown WO: write → 404 (data-model §8.10 tightening), reads → empty
    expect((await call("POST", `/work-orders/nope/daily-report/entries`, { text: "x" })).status).toBe(404);
    expect((await call("GET", `/work-orders/nope/daily-report/days`)).json).toEqual({ days: [] });
  });
});
