//==============================================================================
// pg-visits.test.ts — visits CRUD on the Postgres path (P2). The sandbox has no
// calendar configured, so visits are plain rows: eventId/htmlLink stay null and
// nothing calls Google. Runs the REAL router against the sandbox tenant.
//==============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { adminQuery, callApi, countSandboxEvents, resetSandboxForTests, sandboxAvailable, sandboxEnv, SANDBOX_TENANT } from "./_sandbox";

const up = await sandboxAvailable();
const woId = (n: number) => `f4200006-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const VISIT_KEYS = ["id", "start", "end", "attendees", "label", "calendarId", "eventId", "htmlLink", "confirmed", "confirmTodoId", "remote"];
const SCHEDULE_KEYS = ["calendarId", "eventId", "start", "end", "attendees", "htmlLink"];

const inDays = (d: number, h = 0) => new Date(Date.now() + d * 864e5 + h * 36e5).toISOString();

describe.skipIf(!up)("Postgres visits (sandbox tenant, no calendar)", () => {
  let env: Env;
  const call = (method: string, path: string, body?: unknown) => callApi(worker, env, method, path, body);

  beforeAll(async () => {
    await resetSandboxForTests();
    env = sandboxEnv();
  });

  it("POST /work-orders/:id/visits adds a visit row (no Google), flips the WO to Scheduled, returns the WorkOrder", async () => {
    const id = woId(25); // Not Scheduled, no visits
    const before = await countSandboxEvents("visit.created");
    const start = inDays(2, 9);
    const end = inDays(2, 11);
    const r = await call("POST", `/work-orders/${id}/visits`, { start, end, attendees: ["dana.whitfield@genesis-sandbox.example", "tyler.brooks@genesis-sandbox.example"], label: "Day 1" });
    expect(r.status).toBe(201);
    expect(r.json.id).toBe(id);
    expect(r.json.visits.length).toBe(1);
    const v = r.json.visits[0];
    expect(Object.keys(v)).toEqual(VISIT_KEYS);
    expect(v).toEqual({ id: expect.any(String), start, end, attendees: ["dana.whitfield@genesis-sandbox.example", "tyler.brooks@genesis-sandbox.example"], label: "Day 1", calendarId: "", eventId: null, htmlLink: null, confirmed: true, confirmTodoId: null, remote: false });
    expect(Object.keys(r.json.schedule)).toEqual(SCHEDULE_KEYS);
    expect(r.json.schedule.start).toBe(start);
    expect(r.json.woStatus).toBe("Scheduled");
    expect(r.json.scheduleStatus).toBe("scheduled");
    expect(r.json.cycleStatusRaw).toBe("Not Scheduled"); // stored value untouched by a visit add — the view derives
    // attendees back-filled to the technician users by email
    const att = await adminQuery((sql) => sql`select email, technician_id, position from public.visit_attendees where tenant_id = ${SANDBOX_TENANT} and visit_id = ${v.id} order by position`);
    expect(att.map((a) => a.position)).toEqual([0, 1]);
    expect(att.every((a) => a.technician_id !== null)).toBe(true);
    expect(await countSandboxEvents("visit.created")).toBe(before + 1);
    expect((await call("POST", `/work-orders/${id}/visits`, { start })).status).toBe(400);
    expect((await call("POST", `/work-orders/${crypto.randomUUID()}/visits`, { start, end })).status).toBe(404);
  });

  it("PATCH /work-orders/:id/visits/:visitId updates times / attendees / label / remote; a second visit sorts by start", async () => {
    const id = woId(25);
    const wo = (await call("GET", `/work-orders/${id}`)).json;
    const first = wo.visits[0];
    const start = inDays(1, 13);
    const end = inDays(1, 15);
    const r = await call("PATCH", `/work-orders/${id}/visits/${first.id}`, { start, end, attendees: ["priya.natarajan@genesis-sandbox.example"], label: "Moved up", remote: true });
    expect(r.status).toBe(200);
    const v = r.json.visits.find((x: any) => x.id === first.id);
    expect(v).toEqual({ ...first, start, end, attendees: ["priya.natarajan@genesis-sandbox.example"], label: "Moved up", remote: true });
    // add a later visit; the earliest one drives `schedule`
    const later = await call("POST", `/work-orders/${id}/visits`, { start: inDays(5), end: inDays(5, 2), label: "Return" });
    expect(later.json.visits.map((x: any) => x.label)).toEqual(["Moved up", "Return"]);
    expect(later.json.schedule.start).toBe(start);
    expect((await call("PATCH", `/work-orders/${id}/visits/${crypto.randomUUID()}`, { label: "x" })).status).toBe(404);
  });

  it("tentative visit + notifyConfirmer creates the confirm to-do; /confirm resolves it and marks the visit confirmed", async () => {
    const id = woId(19); // Not Scheduled
    const r = await call("POST", `/work-orders/${id}/visits`, { start: inDays(4, 9), end: inDays(4, 12), pending: true, notifyConfirmer: true });
    expect(r.status).toBe(201);
    const v = r.json.visits[0];
    expect(v.confirmed).toBe(false);
    expect(v.confirmTodoId).toEqual(expect.any(String));
    const todo = r.json.todos.find((t: any) => t.id === v.confirmTodoId);
    expect(todo).toBeTruthy();
    expect(todo.title).toMatch(/^Confirm appointment — /);
    expect(todo.assignee).toBe("Angie Hartman"); // sandbox admin.scheduling_confirmer is [] → default
    expect(todo.urgency).toBe("high");
    expect(todo.status).toBe("Open");
    // a tentative visit without notifyConfirmer gets no to-do
    const quiet = await call("POST", `/work-orders/${id}/visits`, { start: inDays(6, 9), end: inDays(6, 12), pending: true });
    const qv = quiet.json.visits.find((x: any) => x.start !== v.start);
    expect([qv.confirmed, qv.confirmTodoId]).toEqual([false, null]);

    const c = await call("POST", `/work-orders/${id}/visits/${v.id}/confirm`);
    expect(c.status).toBe(200);
    const cv = c.json.visits.find((x: any) => x.id === v.id);
    expect(cv.confirmed).toBe(true);
    expect(cv.confirmTodoId).toBe(v.confirmTodoId);
    expect(c.json.todos.some((t: any) => t.id === v.confirmTodoId)).toBe(false); // archived (Completed) → off the active list
    const archived = await call("GET", `/work-orders/${id}/todos?archived=1`);
    expect(archived.json.todos.find((t: any) => t.id === v.confirmTodoId)).toMatchObject({ status: "Completed", archived: true });
    expect((await call("POST", `/work-orders/${id}/visits/${crypto.randomUUID()}/confirm`)).status).toBe(404);
  });

  it("DELETE /work-orders/:id/visits/:visitId soft-deletes; the WO re-derives to Not Scheduled when no visits remain", async () => {
    const id = woId(25);
    const wo = (await call("GET", `/work-orders/${id}`)).json;
    expect(wo.visits.length).toBe(2);
    const before = await countSandboxEvents("visit.deleted");
    for (const v of wo.visits) {
      const r = await call("DELETE", `/work-orders/${id}/visits/${v.id}`);
      expect(r.status).toBe(200);
    }
    const after = (await call("GET", `/work-orders/${id}`)).json;
    expect(after.visits).toEqual([]);
    expect(after.woStatus).toBe("Not Scheduled");
    expect(after.schedule).toEqual({ calendarId: "", eventId: null, start: null, end: null, attendees: [], htmlLink: null });
    expect(await countSandboxEvents("visit.deleted")).toBe(before + 2);
    const rows = await adminQuery((sql) => sql`select count(*)::int as n from public.visits where tenant_id = ${SANDBOX_TENANT} and work_order_id = ${id} and deleted_at is not null`);
    expect(rows[0].n).toBe(2);
    expect((await call("DELETE", `/work-orders/${id}/visits/${wo.visits[0].id}`)).status).toBe(404);
  });

  it("PATCH /work-orders/:id { schedule } edits the FIRST visit, or creates it when there is none", async () => {
    const id = woId(23); // no visits
    const start = inDays(3, 8);
    const end = inDays(3, 10);
    const created = await call("PATCH", `/work-orders/${id}`, { schedule: { start, end, attendees: ["jordan.ellis@genesis-sandbox.example"] } });
    expect(created.status).toBe(200);
    expect(created.json.visits.length).toBe(1);
    expect(created.json.schedule).toMatchObject({ start, end, attendees: ["jordan.ellis@genesis-sandbox.example"] });
    expect(created.json.woStatus).toBe("Scheduled");
    const moved = await call("PATCH", `/work-orders/${id}`, { schedule: { start: inDays(8, 8), end: inDays(8, 10) } });
    expect(moved.json.visits.length).toBe(1);
    expect(moved.json.visits[0].attendees).toEqual(["jordan.ellis@genesis-sandbox.example"]); // untouched
    expect(moved.json.schedule.start).toBe(inDays(8, 8).slice(0, 13) + moved.json.schedule.start.slice(13));
    // a past visit on an open WO → Needs Reschedule
    const past = await call("PATCH", `/work-orders/${id}`, { schedule: { start: inDays(-3, 8), end: inDays(-3, 10) } });
    expect(past.json.scheduleStatus).toBe("needs_reschedule");
    expect(past.json.woStatus).toBe("Needs Reschedule");
    expect((await call("GET", "/work-orders?filter=active&schedule=needs_reschedule")).json.workOrders.some((w: any) => w.id === id)).toBe(true);
  });

  it("seeded overdue / tentative / remote visits serialize as booleans and ISO instants", async () => {
    const wo14 = (await call("GET", `/work-orders/${woId(14)}`)).json;
    expect(wo14.visits[0].remote).toBe(true);
    expect(wo14.visits[0].start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const wo7 = (await call("GET", `/work-orders/${woId(7)}`)).json;
    expect(wo7.scheduleStatus).toBe("needs_reschedule");
    expect(wo7.woStatus).toBe("Needs Reschedule");
    const wo21 = (await call("GET", `/work-orders/${woId(21)}`)).json;
    expect(wo21.visits[0].confirmed).toBe(false);
  });
});
