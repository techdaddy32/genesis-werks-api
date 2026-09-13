//==============================================================================
// pg-shape.test.ts — the UI-contract probe for the Postgres path (P2).
//
// For every route the Allspark SWO page consumes, the JSON produced by the
// sandbox (Postgres) tenant must carry EXACTLY the top-level keys data-model.md
// §4 lists for the Zoho path — plus the ONE additive key `custom` on WorkOrder,
// PurchaseItem and ProjectHit. The lists below are encoded from §4 / types.ts
// (they are the contract, not derived from the code). Keys are compared both
// sorted (set equality) and in wire order (the Zoho serializers' order).
//==============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { callApi, resetSandboxForTests, sandboxAvailable, sandboxEnv } from "./_sandbox";

const up = await sandboxAvailable();
const woId = (n: number) => `f4200006-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** §4 — WorkOrder (LIST and DETAIL share one key set; §8.5 fills the list) + the additive `custom`. */
const WORK_ORDER_KEYS = [
  "id", "workOrderNumber", "projectKey", "mintedRef", "projectId", "projectName", "client", "siteAddress",
  "membershipLevel", "subject", "companyCamUrl", "provision", "woType", "billingStatus", "billable", "statusTaskId",
  "cycleStatusRaw", "status", "scheduleStatus", "woStatus", "priority", "taskListId", "actionTaskId", "billingTaskId",
  "dailyReportTaskId", "todoTaskId", "todos", "tasks", "notes", "accessCodes", "schedule", "visits", "usedItems", "hours",
  "createdAt", "updatedAt", "custom",
];
/** POST /work-orders adds `scheduleError` (request-only, §2.3). */
const CREATE_KEYS = [...WORK_ORDER_KEYS, "scheduleError"];
const TASK_KEYS = ["id", "name", "isCompleted", "kind", "taskStatus"];
const VISIT_KEYS = ["id", "start", "end", "attendees", "label", "calendarId", "eventId", "htmlLink", "confirmed", "confirmTodoId", "remote"];
const SCHEDULE_KEYS = ["calendarId", "eventId", "start", "end", "attendees", "htmlLink"];
const ACCESS_CODE_KEYS = ["gate_code", "community_gate", "door_code"];
const HOURS_KEYS = ["total", "entries"];
const HOURS_ENTRY_KEYS = ["tech", "hours", "at", "note"];
const ITEM_KEYS = ["id", "item", "quantity", "note", "status", "sourceWo", "sourceWoId", "archived", "createdAt", "custom"];
const TODO_KEYS = ["id", "title", "status", "urgency", "assignee", "notes", "workOrderId", "workOrderNumber", "archived", "createdAt", "updatedAt"];
const MATERIAL_KEYS = ["id", "name", "notes", "fromRequest", "sourceItem", "sourceItemId", "completed", "workOrderId", "createdAt", "updatedAt"];
const PROJECT_KEYS = ["id", "key", "name", "client", "siteAddress", "siteCity", "siteState", "siteZip", "isService", "membershipLevel", "custom"];
const TECHNICIAN_KEYS = ["id", "name", "email", "active", "createdAt", "updatedAt"];
const TASK_RESULT_KEYS = ["workOrder", "autoPromoted", "gateMessage"];

const sorted = (o: object) => Object.keys(o).sort();
/** Set equality (sorted) AND wire order. */
function expectKeys(o: object, keys: string[]): void {
  expect(sorted(o)).toEqual([...keys].sort());
  expect(Object.keys(o)).toEqual(keys);
}

/** Value vocabularies (§2.3 / §5) every WO must respect. */
const LIFECYCLES = ["action", "billing", "completed"];
const SCHEDULE_STATES = ["unscheduled", "scheduled", "needs_reschedule"];
const WO_STATUSES = ["Not Scheduled", "Scheduled", "Needs Reschedule", "On Hold", "Active Monitoring", "Ready for Billing", "Waiting Payment", "Closed"];
const BILLING = ["Billable", "Non-Billable", "Internal"];
const PRIORITIES = ["none", "low", "medium", "high", null];

function expectWorkOrderContract(wo: any): void {
  expectKeys(wo.accessCodes, ACCESS_CODE_KEYS);
  expectKeys(wo.schedule, SCHEDULE_KEYS);
  expectKeys(wo.hours, HOURS_KEYS);
  for (const t of wo.tasks) expectKeys(t, TASK_KEYS);
  for (const v of wo.visits) expectKeys(v, VISIT_KEYS);
  for (const t of wo.todos) expectKeys(t, TODO_KEYS);
  for (const h of wo.hours.entries) expectKeys(h, HOURS_ENTRY_KEYS);
  expect(LIFECYCLES).toContain(wo.status);
  expect(SCHEDULE_STATES).toContain(wo.scheduleStatus);
  expect(WO_STATUSES).toContain(wo.woStatus);
  expect(WO_STATUSES).toContain(wo.cycleStatusRaw);
  expect(BILLING).toContain(wo.billingStatus);
  expect(wo.billable).toBe(wo.billingStatus === "Billable");
  expect(PRIORITIES).toContain(wo.priority);
  expect(typeof wo.provision).toBe("string");
  expect(typeof wo.woType).toBe("string");
  expect(wo.usedItems).toEqual([]);
  expect(typeof wo.statusTaskId).toBe("string");
  expect(typeof wo.taskListId).toBe("string");
  expect(wo.tasks[0].kind).toBe("work");
  expect(wo.tasks.length === 1 || wo.tasks[1].kind === "billing").toBe(true);
  expect(wo.actionTaskId).toBe(wo.tasks[0].id);
  expect(wo.billingTaskId).toBe(wo.tasks[1]?.id ?? null);
  expect(wo.custom && typeof wo.custom === "object" && !Array.isArray(wo.custom)).toBe(true);
  expect(wo.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(wo.mintedRef).toBe(wo.workOrderNumber.replace(`${wo.projectKey}-WO-`, ""));
}

describe.skipIf(!up)("Postgres path — §4 JSON shape contract (sandbox tenant)", () => {
  let env: Env;
  const call = (method: string, path: string, body?: unknown) => callApi(worker, env, method, path, body);

  beforeAll(async () => {
    await resetSandboxForTests();
    env = sandboxEnv();
  });

  it("GET /work-orders (LIST) — every row has exactly the WorkOrder keys and vocabularies", async () => {
    const r = await call("GET", "/work-orders?filter=all");
    expect(Object.keys(r.json)).toEqual(["count", "workOrders"]);
    expect(r.json.count).toBe(25);
    for (const wo of r.json.workOrders) {
      expectKeys(wo, WORK_ORDER_KEYS);
      expectWorkOrderContract(wo);
    }
  });

  it("GET /work-orders/:id (DETAIL) — same keys as the list (§8.5), real child rows", async () => {
    for (const n of [1, 5, 6, 21, 25]) {
      const r = await call("GET", `/work-orders/${woId(n)}`);
      expect(r.status).toBe(200);
      expectKeys(r.json, WORK_ORDER_KEYS);
      expectWorkOrderContract(r.json);
    }
    const wo5 = (await call("GET", `/work-orders/${woId(5)}`)).json;
    expect(wo5.hours.entries.length).toBe(5);
    expect(wo5.visits.length).toBe(2);
  });

  it("POST /work-orders — the create response = WorkOrder + scheduleError; PATCH/tasks/visits return WorkOrder", async () => {
    const created = await call("POST", "/work-orders", { projectId: (await call("GET", "/projects")).json.projects[0].id, subject: "Shape probe" });
    expect(created.status).toBe(201);
    expectKeys(created.json, CREATE_KEYS);
    expectWorkOrderContract(created.json);
    const patched = await call("PATCH", `/work-orders/${created.json.id}`, { notes: "n" });
    expectKeys(patched.json, WORK_ORDER_KEYS);
    const task = await call("PATCH", `/work-orders/${created.json.id}/tasks/${created.json.actionTaskId}`, { taskStatus: "Completed" });
    expectKeys(task.json, TASK_RESULT_KEYS);
    expectKeys(task.json.workOrder, WORK_ORDER_KEYS);
    const start = new Date(Date.now() + 864e5).toISOString();
    const visit = await call("POST", `/work-orders/${created.json.id}/visits`, { start, end: start });
    expect(visit.status).toBe(201);
    expectKeys(visit.json, WORK_ORDER_KEYS);
    expectKeys(visit.json.visits[0], VISIT_KEYS);
    const hours = await call("POST", `/work-orders/${created.json.id}/hours`, { hours: 1 });
    expectKeys(hours.json, WORK_ORDER_KEYS);
    expectKeys(hours.json.hours.entries[0], HOURS_ENTRY_KEYS);
    const del = await call("DELETE", `/work-orders/${created.json.id}`);
    expect(Object.keys(del.json)).toEqual(["deleted", "id"]);
  });

  it("GET /items + /work-orders/:id/items + PATCH /items/:id — PurchaseItem keys", async () => {
    const r = await call("GET", "/items?archived=1");
    expect(Object.keys(r.json)).toEqual(["count", "items"]);
    expect(r.json.count).toBe(20);
    for (const i of r.json.items) {
      expectKeys(i, ITEM_KEYS);
      expect(typeof i.archived).toBe("boolean");
      expect(i.quantity === null || typeof i.quantity === "number").toBe(true);
      expect(typeof i.sourceWoId).toBe("string");
    }
    const per = await call("GET", `/work-orders/${woId(19)}/items`);
    expect(Object.keys(per.json)).toEqual(["count", "items"]);
    for (const i of per.json.items) expectKeys(i, ITEM_KEYS);
    const added = await call("POST", `/work-orders/${woId(19)}/items`, { item: "probe" });
    expectKeys(added.json, ITEM_KEYS);
    const patched = await call("PATCH", `/items/${added.json.id}`, { status: "On Order" });
    expectKeys(patched.json, ITEM_KEYS);
    expect(Object.keys((await call("DELETE", `/items/${added.json.id}`)).json)).toEqual(["deleted", "id"]);
  });

  it("GET /technicians — Technician keys (already Postgres since F3; the sandbox seeds 5)", async () => {
    const r = await call("GET", "/technicians");
    expect(Object.keys(r.json)).toEqual(["count", "technicians"]);
    expect(r.json.count).toBe(5);
    for (const t of r.json.technicians) expectKeys(t, TECHNICIAN_KEYS);
  });

  it("GET /projects, /todos, /work-orders/:id/materials — ProjectHit / Todo / Material keys", async () => {
    const p = await call("GET", "/projects");
    expect(Object.keys(p.json)).toEqual(["count", "projects"]);
    for (const x of p.json.projects) expectKeys(x, PROJECT_KEYS);
    const t = await call("GET", "/todos?archived=1");
    expect(Object.keys(t.json)).toEqual(["count", "todos"]);
    expect(t.json.count).toBe(6);
    for (const x of t.json.todos) expectKeys(x, TODO_KEYS);
    const m = await call("GET", `/work-orders/${woId(8)}/materials`);
    expect(Object.keys(m.json)).toEqual(["count", "materials"]);
    for (const x of m.json.materials) expectKeys(x, MATERIAL_KEYS);
    const membership = await call("PUT", `/projects/${p.json.projects[0].id}/membership`, { value: "Elite" });
    expect(Object.keys(membership.json)).toEqual(["ok", "membershipLevel"]);
  });
});
