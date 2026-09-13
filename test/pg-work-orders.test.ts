//==============================================================================
// pg-work-orders.test.ts — the Postgres-backed work-order routes (P2) against the
// Genesis Sandbox tenant, through the REAL router (no Zoho, no Google, no mocks).
//
// Requires the local test DB (genesis_api) AND the owner URL for the reset — see
// test/_sandbox.ts. Skips cleanly when either is down.
//==============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { adminQuery, callApi, countSandboxEvents, resetSandboxForTests, sandboxAvailable, sandboxEnv, SANDBOX_TENANT } from "./_sandbox";

const up = await sandboxAvailable();

/** Sandbox deterministic ids (0003: pg_temp.sbid(entity, n)) — entity 6 = work_orders, 5 = projects. */
const woId = (n: number) => `f4200006-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const projectId = (n: number) => `f4200005-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const GS_102 = projectId(0x66);
const GS_108 = projectId(0x6c);

describe.skipIf(!up)("Postgres work orders (sandbox tenant)", () => {
  let env: Env;
  const call = (method: string, path: string, body?: unknown) => callApi(worker, env, method, path, body);

  beforeAll(async () => {
    await resetSandboxForTests();
    env = sandboxEnv();
  });

  // ---- LIST -------------------------------------------------------------------
  it("GET /work-orders?filter=all lists every seeded WO (25) with the FILLED list shape", async () => {
    const r = await call("GET", "/work-orders?filter=all");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["count", "workOrders"]);
    expect(r.json.count).toBe(25);
    const numbers = r.json.workOrders.map((w: any) => w.workOrderNumber);
    expect(new Set(numbers).size).toBe(25);
    expect(numbers.every((n: string) => /^GS-10[1-8]-WO-\d{4}-00(0[1-9]|1\d|2[0-5])$/.test(n))).toBe(true);
    // §8.5: list rows are FILLED — membership, notes, access codes, hours, todos are real values.
    const wo5 = r.json.workOrders.find((w: any) => w.id === woId(5));
    expect(wo5.hours.total).toBeGreaterThan(0);
    expect(wo5.hours.entries.length).toBe(5);
    const wo25 = r.json.workOrders.find((w: any) => w.id === woId(25));
    expect(wo25.membershipLevel).toBe("Preferred");
    expect(wo25.notes).toMatch(/Chime rings twice/);
    expect(wo25.accessCodes).toEqual({ gate_code: null, community_gate: "Sawgrass Bend: call box, dial 088", door_code: "2468" });
    const wo21 = r.json.workOrders.find((w: any) => w.id === woId(21));
    expect(wo21.todos.length).toBe(1);
    expect(wo21.visits[0].confirmed).toBe(false); // the TENTATIVE visit
    expect(wo21.visits[0].confirmTodoId).toBe(wo21.todos[0].id);
    // synthesized ids per data-model §4
    expect(wo25.taskListId).toBe(wo25.id);
    expect(wo25.statusTaskId).toBe(wo25.id);
    expect(wo25.actionTaskId).toBe(wo25.tasks[0].id);
    expect(wo25.billingTaskId).toBe(wo25.tasks[1].id);
    expect(wo25.usedItems).toEqual([]);
    expect(wo25.custom).toEqual({});
  });

  it("filters: active (default) / billing / done partition the board; ?schedule= narrows it", async () => {
    const active = await call("GET", "/work-orders");
    const billing = await call("GET", "/work-orders?filter=billing");
    const done = await call("GET", "/work-orders?filter=done");
    expect([active.json.count, billing.json.count, done.json.count]).toEqual([16, 4, 5]);
    expect(active.json.workOrders.every((w: any) => w.status === "action")).toBe(true);
    expect(billing.json.workOrders.map((w: any) => w.woStatus).sort()).toEqual(["Ready for Billing", "Ready for Billing", "Waiting Payment", "Waiting Payment"]);
    expect(done.json.workOrders.every((w: any) => w.woStatus === "Closed" && w.status === "completed")).toBe(true);

    const unscheduled = await call("GET", "/work-orders?filter=all&schedule=unscheduled");
    expect(unscheduled.json.count).toBe(5);
    expect(unscheduled.json.workOrders.every((w: any) => w.scheduleStatus === "unscheduled" && w.woStatus === "Not Scheduled")).toBe(true);
    const needs = await call("GET", "/work-orders?filter=active&schedule=needs_reschedule");
    expect(needs.json.workOrders.map((w: any) => w.woStatus).sort()).toEqual(["Active Monitoring", "Needs Reschedule", "Needs Reschedule", "Needs Reschedule", "On Hold"]);
    expect((await call("GET", "/work-orders?filter=nope")).status).toBe(400);
  });

  it("search ?q= matches WO#, client, site address and subject (case-insensitive)", async () => {
    expect((await call("GET", "/work-orders?filter=all&q=bellamy")).json.count).toBe(4);
    expect((await call("GET", "/work-orders?filter=all&q=WO-2026-0025")).json.count).toBe(1);
    expect((await call("GET", "/work-orders?filter=all&q=sawgrass")).json.count).toBe(4);
    expect((await call("GET", "/work-orders?filter=all&q=doorbell")).json.count).toBe(2); // subjects only — the third mention is in notes
    expect((await call("GET", "/work-orders?filter=all&q=zzz-nothing")).json.count).toBe(0);
  });

  it("sorts: newest / oldest by createdAt, client by name, priority high→medium→low→none", async () => {
    const newest = (await call("GET", "/work-orders?filter=all&sort=newest")).json.workOrders.map((w: any) => w.createdAt);
    expect(newest).toEqual([...newest].sort().reverse());
    const oldest = (await call("GET", "/work-orders?filter=all&sort=oldest")).json.workOrders.map((w: any) => w.createdAt);
    expect(oldest).toEqual([...oldest].sort());
    const clients = (await call("GET", "/work-orders?filter=all&sort=client")).json.workOrders.map((w: any) => w.client);
    expect(clients).toEqual([...clients].sort((a, b) => a.localeCompare(b)));
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const prios = (await call("GET", "/work-orders?filter=all&sort=priority")).json.workOrders.map((w: any) => rank[w.priority] ?? 3);
    expect(prios).toEqual([...prios].sort((a, b) => a - b));
    expect(prios[0]).toBe(0);
    expect(prios[prios.length - 1]).toBe(3);
  });

  // ---- DETAIL -----------------------------------------------------------------
  it("GET /work-orders/:id returns the DETAIL shape with the derived fields and 404 for unknown ids", async () => {
    const r = await call("GET", `/work-orders/${woId(6)}`);
    expect(r.status).toBe(200);
    const wo = r.json;
    expect(wo.workOrderNumber).toBe("GS-105-WO-2026-0006");
    expect(wo.projectKey).toBe("GS-105");
    expect(wo.mintedRef).toBe("2026-0006");
    expect(wo.woType).toBe("Prewire WO");
    expect(wo.status).toBe("action");
    expect(wo.scheduleStatus).toBe("scheduled");
    expect(wo.woStatus).toBe("Scheduled");
    expect(wo.cycleStatusRaw).toBe("Scheduled");
    expect(wo.visits.length).toBe(2);
    expect(wo.visits[0].start < wo.visits[1].start).toBe(true);
    expect(wo.schedule.start).toBe(wo.visits[0].start);
    expect(wo.schedule.calendarId).toBe(""); // no calendar configured in the sandbox
    expect(wo.visits[0].attendees.length).toBeGreaterThan(0);
    expect(wo.tasks.map((t: any) => [t.kind, t.taskStatus, t.isCompleted])).toEqual([["work", "Pending", false], ["billing", "Pending", false]]);
    expect(wo.billable).toBe(true);
    // a Closed WO
    const closed = (await call("GET", `/work-orders/${woId(1)}`)).json;
    expect([closed.status, closed.woStatus, closed.billingStatus, closed.billable]).toEqual(["completed", "Closed", "Non-Billable", false]);
    expect(closed.tasks.map((t: any) => t.taskStatus)).toEqual(["Completed", "Completed"]);
    // custom fields on the seeded WOs
    const withCustom = (await call("GET", "/work-orders?filter=all")).json.workOrders.filter((w: any) => Object.keys(w.custom).length);
    expect(withCustom.length).toBe(6);
    expect((await call("GET", `/work-orders/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("GET", "/work-orders/not-a-uuid")).status).toBe(404);
  });

  // ---- CREATE -----------------------------------------------------------------
  it("POST /work-orders mints GS-102-WO-YYYY-0026, creates work+billing (+steps), writes codes to the project, appends an event", async () => {
    const before = await countSandboxEvents("work_order.created");
    const r = await call("POST", "/work-orders", {
      projectId: GS_102,
      subject: "Replace Ring transformer",
      notes: "Bring a 16V 30VA transformer.",
      priority: "High",
      steps: ["Check chime kit", "Swap transformer"],
      accessCodes: { gate_code: "1111" },
      billingStatus: "Non-Billable",
      woType: "Service WO",
      provision: "https://provision.example/1",
      custom: { po_number: "PO-2026-17", warranty: "Yes" },
    });
    expect(r.status).toBe(201);
    const wo = r.json;
    const year = new Date().getFullYear();
    expect(wo.workOrderNumber).toBe(`GS-102-WO-${year}-0026`);
    expect(wo.projectKey).toBe("GS-102");
    expect(wo.mintedRef).toBe(`${year}-0026`);
    expect(wo.projectId).toBe(GS_102);
    expect(wo.client).toBe("Bellamy, Grace");
    expect(wo.subject).toBe("Replace Ring transformer");
    expect(wo.notes).toBe("Bring a 16V 30VA transformer.");
    expect(wo.priority).toBe("high");
    expect(wo.billingStatus).toBe("Non-Billable");
    expect(wo.billable).toBe(false);
    expect(wo.woType).toBe("Service WO");
    expect(wo.provision).toBe("https://provision.example/1");
    expect(wo.companyCamUrl).toBeNull();
    expect(wo.woStatus).toBe("Not Scheduled");
    expect(wo.status).toBe("action");
    expect(wo.scheduleStatus).toBe("unscheduled");
    expect(wo.tasks.map((t: any) => [t.name, t.kind, t.taskStatus])).toEqual([["Work Order Tasks", "work", "Pending"], ["Billing", "billing", "Pending"]]);
    expect(wo.accessCodes.gate_code).toBe("1111");
    expect(wo.accessCodes.door_code).toBe("2468"); // untouched
    expect(wo.custom).toEqual({ po_number: "PO-2026-17", warranty: "Yes" });
    expect(wo.scheduleError).toBeNull();
    expect(wo.visits).toEqual([]);
    expect(wo.hours).toEqual({ total: 0, entries: [] });

    const steps = await adminQuery((sql) => sql`select name, task_status, parent_task_id from public.wo_tasks where tenant_id = ${SANDBOX_TENANT} and work_order_id = ${wo.id} and kind = 'step' order by position`);
    expect(steps.map((s) => s.name)).toEqual(["Check chime kit", "Swap transformer"]);
    expect(steps.every((s) => s.parent_task_id === wo.actionTaskId)).toBe(true);
    const project = await adminQuery((sql) => sql`select gate_code from public.projects where id = ${GS_102}`);
    expect(project[0].gate_code).toBe("1111");
    expect(await countSandboxEvents("work_order.created")).toBe(before + 1);
    // the sibling WOs of the project now carry the new gate code too (codes live on the PROJECT)
    expect((await call("GET", `/work-orders/${woId(25)}`)).json.accessCodes.gate_code).toBe("1111");
    expect((await call("GET", "/work-orders?filter=all")).json.count).toBe(26);
  });

  it("POST /work-orders rejects an invalid custom payload (400) and burns no number; unknown project → 500 envelope", async () => {
    const bad = await call("POST", "/work-orders", { projectId: GS_102, subject: "x", custom: { warranty: "Maybe" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/invalid custom fields/);
    expect(bad.json.fields[0].key).toBe("warranty");
    const bad2 = await call("POST", "/work-orders", { projectId: GS_102, subject: "x", custom: { nope: 1 } });
    expect(bad2.status).toBe(400);
    const next = await call("POST", "/work-orders", { projectId: GS_102, subject: "y", billable: false });
    expect(next.json.workOrderNumber).toMatch(/-0027$/); // 0026 was consumed, the failed create burned nothing
    expect(next.json.billingStatus).toBe("Non-Billable");
    expect((await call("POST", "/work-orders", { subject: "x" })).status).toBe(400);
    expect((await call("POST", "/work-orders", { projectId: crypto.randomUUID(), subject: "x" })).status).toBe(500);
  });

  it("POST /work-orders with a schedule creates the first visit as a plain row (no calendar in the sandbox)", async () => {
    const start = new Date(Date.now() + 3 * 864e5).toISOString();
    const end = new Date(Date.now() + 3 * 864e5 + 2 * 36e5).toISOString();
    const r = await call("POST", "/work-orders", {
      projectId: GS_108,
      subject: "Model home tune-up",
      schedule: { start, end, attendees: ["marcus.reyes@genesis-sandbox.example"], remote: false },
    });
    expect(r.status).toBe(201);
    expect(r.json.scheduleError).toBeNull();
    expect(r.json.visits.length).toBe(1);
    expect(r.json.visits[0]).toEqual({
      id: expect.any(String),
      start,
      end,
      attendees: ["marcus.reyes@genesis-sandbox.example"],
      label: null,
      calendarId: "",
      eventId: null,
      htmlLink: null,
      confirmed: true,
      confirmTodoId: null,
      remote: false,
    });
    expect(r.json.schedule).toEqual({ calendarId: "", eventId: null, start, end, attendees: ["marcus.reyes@genesis-sandbox.example"], htmlLink: null });
    expect(r.json.woStatus).toBe("Scheduled");
    expect(r.json.scheduleStatus).toBe("scheduled");
  });

  // ---- PATCH ------------------------------------------------------------------
  it("PATCH /work-orders/:id edits subject / notes / priority / codes / billing / urls / custom (merge) and appends an event", async () => {
    const id = woId(25);
    const before = await countSandboxEvents("work_order.updated");
    const r = await call("PATCH", `/work-orders/${id}`, {
      subject: "Doorbell chime — intermittent",
      notes: "Updated notes",
      priority: "low",
      accessCodes: { door_code: "9999" },
      billable: false,
      companyCamUrl: "https://app.companycam.com/p/1",
      provision: "",
      woType: "Production WO",
      custom: { po_number: "PO-25" },
    });
    expect(r.status).toBe(200);
    expect(r.json.subject).toBe("Doorbell chime — intermittent");
    expect(r.json.notes).toBe("Updated notes");
    expect(r.json.priority).toBe("low");
    expect(r.json.accessCodes.door_code).toBe("9999");
    expect(r.json.billingStatus).toBe("Non-Billable");
    expect(r.json.billable).toBe(false);
    expect(r.json.companyCamUrl).toBe("https://app.companycam.com/p/1");
    expect(r.json.provision).toBe("");
    expect(r.json.woType).toBe("Production WO");
    expect(r.json.custom).toEqual({ po_number: "PO-25" });
    // merge: add a key, then delete one with null
    expect((await call("PATCH", `/work-orders/${id}`, { custom: { warranty: "Partial" } })).json.custom).toEqual({ po_number: "PO-25", warranty: "Partial" });
    expect((await call("PATCH", `/work-orders/${id}`, { custom: { po_number: null } })).json.custom).toEqual({ warranty: "Partial" });
    expect((await call("PATCH", `/work-orders/${id}`, { custom: { warranty: "Nope" } })).status).toBe(400);
    // absent keys are left alone; empty companyCamUrl clears
    const again = await call("PATCH", `/work-orders/${id}`, { companyCamUrl: "", billingStatus: "Internal" });
    expect(again.json.companyCamUrl).toBeNull();
    expect(again.json.notes).toBe("Updated notes");
    expect(again.json.billingStatus).toBe("Internal");
    expect(await countSandboxEvents("work_order.updated")).toBe(before + 4); // the rejected custom patch rolled back — no event
    expect((await call("PATCH", `/work-orders/${crypto.randomUUID()}`, { notes: "x" })).status).toBe(404);
    expect((await call("PATCH", `/work-orders/${id}`, { woStatus: "Bogus" })).status).toBe(400);
  });

  it("status transitions: back-half labels stick, scheduling labels re-derive, tasks follow the lifecycle, gate blocks pending items", async () => {
    // WO 25 has a pending item ("Ring chime kit" Needed) → billing/completed targets are refused (409)
    const gated = await call("PATCH", `/work-orders/${woId(25)}`, { woStatus: "Ready for Billing" });
    expect(gated.status).toBe(409);
    expect(gated.json.error).toBe('Cannot complete: 1 requested part(s) still pending — not yet received or marked not needed — "Ring chime kit".');
    expect((await call("GET", `/work-orders/${woId(25)}`)).json.woStatus).toBe("Not Scheduled");

    // WO 12 (no items, no visits): On Hold sticks
    const id = woId(12);
    const held = await call("PATCH", `/work-orders/${id}`, { woStatus: "On Hold" });
    expect(held.json.woStatus).toBe("On Hold");
    expect(held.json.status).toBe("action");
    expect((await call("GET", `/work-orders/${id}`)).json.woStatus).toBe("On Hold");
    // Ready for Billing → work Completed, billing Pending, lifecycle billing
    const rfb = await call("PATCH", `/work-orders/${id}`, { woStatus: "Ready for Billing" });
    expect(rfb.json.woStatus).toBe("Ready for Billing");
    expect(rfb.json.status).toBe("billing");
    expect(rfb.json.tasks.map((t: any) => t.taskStatus)).toEqual(["Completed", "Pending"]);
    // legacy spelling "Completed" → Closed; both tasks Completed; closed_at set
    const closed = await call("PATCH", `/work-orders/${id}`, { woStatus: "Completed" });
    expect(closed.json.woStatus).toBe("Closed");
    expect(closed.json.status).toBe("completed");
    expect(closed.json.tasks.map((t: any) => t.isCompleted)).toEqual([true, true]);
    const row = await adminQuery((sql) => sql`select closed_at, task_list_completed, wo_status from public.work_orders where id = ${id}`);
    expect(row[0].closed_at).not.toBeNull();
    expect(row[0].task_list_completed).toBe(true);
    expect(row[0].wo_status).toBe("Closed");
    expect((await call("GET", "/work-orders?filter=done")).json.workOrders.some((w: any) => w.id === id)).toBe(true);
    // a scheduling label re-derives from the visits (none → Not Scheduled), tasks re-open
    const reopened = await call("PATCH", `/work-orders/${id}`, { woStatus: "Scheduled" });
    expect(reopened.json.woStatus).toBe("Not Scheduled");
    expect(reopened.json.status).toBe("action");
    expect(reopened.json.tasks.map((t: any) => t.taskStatus)).toEqual(["Pending", "Pending"]);
    // legacy 3-state `status`
    expect((await call("PATCH", `/work-orders/${id}`, { status: "billing" })).json.woStatus).toBe("Ready for Billing");
    expect((await call("PATCH", `/work-orders/${id}`, { status: "completed" })).json.woStatus).toBe("Closed");
    expect((await call("PATCH", `/work-orders/${id}`, { status: "action" })).json.woStatus).toBe("Not Scheduled");
    // a WO with a future visit re-derives to Scheduled
    const sched = await call("PATCH", `/work-orders/${woId(6)}`, { woStatus: "Not Scheduled" });
    expect(sched.json.woStatus).toBe("Scheduled");
  });

  it("PATCH /work-orders/:id/tasks/:taskId: completing the work task pre-billing auto-promotes (or reports the gate); reopening returns to the schedule flow", async () => {
    const wo13 = (await call("GET", `/work-orders/${woId(13)}`)).json; // Not Scheduled, no items
    const done = await call("PATCH", `/work-orders/${woId(13)}/tasks/${wo13.actionTaskId}`, { taskStatus: "Completed" });
    expect(done.status).toBe(200);
    expect(Object.keys(done.json)).toEqual(["workOrder", "autoPromoted", "gateMessage"]);
    expect(done.json.autoPromoted).toBe(true);
    expect(done.json.gateMessage).toBeNull();
    expect(done.json.workOrder.woStatus).toBe("Ready for Billing");
    expect(done.json.workOrder.tasks[0].taskStatus).toBe("Completed");
    const back = await call("PATCH", `/work-orders/${woId(13)}/tasks/${wo13.actionTaskId}`, { taskStatus: "Pending" });
    expect(back.json.autoPromoted).toBe(false);
    expect(back.json.workOrder.woStatus).toBe("Not Scheduled");
    expect(back.json.workOrder.tasks.map((t: any) => t.taskStatus)).toEqual(["Pending", "Pending"]);
    // the billing task: field write only
    const bill = await call("PATCH", `/work-orders/${woId(13)}/tasks/${wo13.billingTaskId}`, { taskStatus: "Completed" });
    expect(bill.json.workOrder.tasks[1].taskStatus).toBe("Completed");
    expect(bill.json.workOrder.woStatus).toBe("Not Scheduled");
    // gate: WO 19 has 4 Needed items
    const wo19 = (await call("GET", `/work-orders/${woId(19)}`)).json;
    const gated = await call("PATCH", `/work-orders/${woId(19)}/tasks/${wo19.actionTaskId}`, { taskStatus: "Completed" });
    expect(gated.json.autoPromoted).toBe(false);
    expect(gated.json.gateMessage).toMatch(/^Cannot complete: 4 requested part\(s\) still pending/);
    expect(gated.json.workOrder.woStatus).toBe("Not Scheduled");
    expect(gated.json.workOrder.tasks[0].taskStatus).toBe("Completed");
    expect((await call("PATCH", `/work-orders/${woId(19)}/tasks/${crypto.randomUUID()}`, { taskStatus: "Completed" })).status).toBe(404);
    expect((await call("PATCH", `/work-orders/${woId(19)}/tasks/${wo19.actionTaskId}`, { taskStatus: "Done" })).status).toBe(400);
  });

  // ---- HOURS + DAILY REPORTS on real rows ---------------------------------------
  it("hours and daily reports join the REAL work_orders row (no shadow rows)", async () => {
    const id = woId(23);
    const logged = await call("POST", `/work-orders/${id}/hours`, { hours: 2.5, techEmail: "dana.whitfield@genesis-sandbox.example", note: "Diag" });
    expect(logged.status).toBe(200);
    expect(logged.json.hours).toEqual({ total: 2.5, entries: [{ tech: "dana.whitfield@genesis-sandbox.example", hours: 2.5, at: expect.any(String), note: "Diag" }] });
    const rows = await adminQuery((sql) => sql`select work_order_id from public.hours_entries where tenant_id = ${SANDBOX_TENANT} and note = 'Diag'`);
    expect(rows[0].work_order_id).toBe(id);
    const shadows = await adminQuery((sql) => sql`select count(*)::int as n from public.work_orders where tenant_id = ${SANDBOX_TENANT} and custom ? '_shadow'`);
    expect(shadows[0].n).toBe(0);
    const day = await call("POST", `/work-orders/${id}/daily-report/entries`, { text: "Arrived on site", date: "2026-09-10" });
    expect(day.status).toBe(201);
    expect((await call("GET", `/work-orders/${id}/daily-report/days`)).json.days).toEqual([{ date: "2026-09-10", entries: 1, sent: false, pdfUrl: null }]);
    const sent = await call("POST", `/work-orders/${id}/daily-report/send`, { date: "2026-09-10" });
    expect(sent.status).toBe(200);
    expect(sent.json.pdfUrl).toBe(`https://api.sandbox.test/work-orders/${id}/daily-report/2026-09-10/pdf`);
    expect((await call("GET", `/work-orders/${id}/daily-report/2026-09-10/pdf`)).status).toBe(200);
    const pdf = await call("GET", `/work-orders/${id}/summary.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.res.headers.get("Content-Disposition")).toBe('inline; filename="work-order-summary-GS-101-WO-2026-0023.pdf"');
    expect((await call("POST", `/work-orders/${crypto.randomUUID()}/daily-report/entries`, { text: "x" })).status).toBe(404);
  });

  // ---- DELETE -----------------------------------------------------------------
  it("DELETE /work-orders/:id soft-deletes (404 afterwards, gone from the board, event appended)", async () => {
    const id = woId(20);
    const before = await countSandboxEvents("work_order.deleted");
    const r = await call("DELETE", `/work-orders/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: true, id });
    expect((await call("GET", `/work-orders/${id}`)).status).toBe(404);
    expect((await call("GET", "/work-orders?filter=all")).json.workOrders.some((w: any) => w.id === id)).toBe(false);
    expect((await call("DELETE", `/work-orders/${id}`)).status).toBe(404);
    const row = await adminQuery((sql) => sql`select deleted_at from public.work_orders where id = ${id}`);
    expect(row[0].deleted_at).not.toBeNull();
    expect(await countSandboxEvents("work_order.deleted")).toBe(before + 1);
    // its items drop off the purchasing aggregate too
    expect((await call("GET", "/items?archived=1")).json.items.some((i: any) => i.sourceWoId === id)).toBe(false);
  });

  it("admin/migrate-status and sync/calendar are inert on a Postgres-backed tenant", async () => {
    const r = await call("GET", "/admin/migrate-status?pin=3825");
    expect(r.json).toEqual({ dryRun: true, total: 0, pending: 0, processed: 0, rows: [] });
    expect((await call("POST", "/sync/calendar")).json).toEqual({ scanned: 0, reconciled: 0, conflicts: 0, details: [] });
  });
});
