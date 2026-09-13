//==============================================================================
// pg-projects.test.ts — project list / search / membership / access codes on the
// Postgres path (P2), plus the per-WO todos and materials routes. Real router,
// sandbox tenant.
//==============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { adminQuery, callApi, countSandboxEvents, resetSandboxForTests, sandboxAvailable, sandboxEnv, SANDBOX_TENANT } from "./_sandbox";

const up = await sandboxAvailable();
const woId = (n: number) => `f4200006-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const projectId = (n: number) => `f4200005-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const GS_101 = projectId(0x65);
const PROJECT_KEYS = ["id", "key", "name", "client", "siteAddress", "siteCity", "siteState", "siteZip", "isService", "membershipLevel", "custom"];
const TODO_KEYS = ["id", "title", "status", "urgency", "assignee", "notes", "workOrderId", "workOrderNumber", "archived", "createdAt", "updatedAt"];
const MATERIAL_KEYS = ["id", "name", "notes", "fromRequest", "sourceItem", "sourceItemId", "completed", "workOrderId", "createdAt", "updatedAt"];

describe.skipIf(!up)("Postgres projects / todos / materials (sandbox tenant)", () => {
  let env: Env;
  const call = (method: string, path: string, body?: unknown) => callApi(worker, env, method, path, body);

  beforeAll(async () => {
    await resetSandboxForTests();
    env = sandboxEnv();
  });

  // ---- projects ---------------------------------------------------------------
  it("GET /projects lists the 8 sandbox sites (ProjectHit shape) and searches by name / key / client / address", async () => {
    const r = await call("GET", "/projects");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["count", "projects"]);
    expect(r.json.count).toBe(8);
    for (const p of r.json.projects) expect(Object.keys(p)).toEqual(PROJECT_KEYS);
    const gs101 = r.json.projects.find((p: any) => p.key === "GS-101");
    expect(gs101).toEqual({
      id: GS_101,
      key: "GS-101",
      name: "Okonkwo, Daniel - 1427 Heron Marsh Ln - SERVICE",
      client: "Okonkwo, Daniel",
      siteAddress: "1427 Heron Marsh Ln",
      siteCity: "Winter Garden",
      siteState: "FL",
      siteZip: expect.any(String),
      isService: true,
      membershipLevel: "Elite",
      custom: {},
    });
    expect(r.json.projects.filter((p: any) => p.membershipLevel === null).length).toBe(2);
    expect((await call("GET", "/projects?q=bellamy")).json.count).toBe(1);
    expect((await call("GET", "/projects?q=GS-10")).json.count).toBe(8);
    expect((await call("GET", "/projects?q=Lake%20Mary")).json.count).toBe(0); // city is not searched (the Zoho search was a name search)
    expect((await call("GET", "/projects?q=Sawgrass")).json.count).toBe(1);
    expect((await call("GET", "/projects?q=nothing-here")).json).toEqual({ count: 0, projects: [] });
    expect((await call("GET", "/projects?all=true")).json.count).toBe(8); // every sandbox project is a SERVICE project
  });

  it("PUT /projects/:pid/membership writes projects.membership_level (vocab auto-created), 404 for an unknown project", async () => {
    const before = await countSandboxEvents("project.membership_set");
    const r = await call("PUT", `/projects/${GS_101}/membership`, { value: "Preferred" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, membershipLevel: "Preferred" });
    expect((await call("GET", "/projects")).json.projects.find((p: any) => p.id === GS_101).membershipLevel).toBe("Preferred");
    // the WOs of the project see it (joined, not copied)
    expect((await call("GET", `/work-orders/${woId(1)}`)).json.membershipLevel).toBe("Preferred");
    const novel = await call("POST", `/projects/${GS_101}/membership`, { value: "Platinum" });
    expect(novel.json.membershipLevel).toBe("Platinum");
    const vocab = await adminQuery((sql) => sql`select code from public.status_vocab where tenant_id = ${SANDBOX_TENANT} and domain = 'membership-type' and code = 'Platinum'`);
    expect(vocab.length).toBe(1);
    const cleared = await call("PUT", `/projects/${GS_101}/membership`, { value: "" });
    expect(cleared.json).toEqual({ ok: true, membershipLevel: "" });
    expect((await call("GET", `/work-orders/${woId(1)}`)).json.membershipLevel).toBeNull();
    expect(await countSandboxEvents("project.membership_set")).toBe(before + 3);
    expect((await call("PUT", `/projects/${crypto.randomUUID()}/membership`, { value: "Elite" })).status).toBe(404);
    expect((await call("PUT", `/projects/1545398000005783015/membership`, { value: "Elite" })).status).toBe(404); // a Zoho id nobody imported
  });

  it("access codes live on the PROJECT: a WO patch changes every sibling WO", async () => {
    const r = await call("PATCH", `/work-orders/${woId(8)}`, { accessCodes: { gate_code: "#4321", community_gate: "" } });
    expect(r.json.accessCodes).toEqual({ gate_code: "#4321", community_gate: null, door_code: expect.anything() });
    for (const n of [1, 15, 23]) {
      const sib = (await call("GET", `/work-orders/${woId(n)}`)).json;
      expect(sib.projectId).toBe(GS_101);
      expect(sib.accessCodes.gate_code).toBe("#4321");
      expect(sib.accessCodes.community_gate).toBeNull();
    }
    const row = await adminQuery((sql) => sql`select gate_code, community_gate from public.projects where id = ${GS_101}`);
    expect(row[0]).toEqual({ gate_code: "#4321", community_gate: null });
  });

  // ---- todos ------------------------------------------------------------------
  it("todos: per-WO list / add / patch, the central board and its filters, archiving on Completed", async () => {
    const id = woId(19);
    const list = await call("GET", `/work-orders/${id}/todos`);
    expect(list.json.count).toBe(1);
    expect(Object.keys(list.json.todos[0])).toEqual(TODO_KEYS);
    expect(list.json.todos[0]).toMatchObject({ title: "Ask Beth when paint is done", status: "Open", workOrderId: id, workOrderNumber: "GS-105-WO-2026-0019", archived: false });

    const before = await countSandboxEvents("todo.created");
    const added = await call("POST", `/work-orders/${id}/todos`, { title: "Order rack shelves", priority: "HIGH", assignee: "Renee Castillo", notes: "2 shelves" });
    expect(added.status).toBe(201);
    expect(Object.keys(added.json)).toEqual(TODO_KEYS);
    expect(added.json).toMatchObject({ title: "Order rack shelves", status: "Open", urgency: "high", assignee: "Renee Castillo", notes: "2 shelves", workOrderId: id, archived: false });
    expect(await countSandboxEvents("todo.created")).toBe(before + 1);
    const odd = await call("POST", `/work-orders/${id}/todos`, { title: "Odd", priority: "urgent", status: "Awaiting Feedback" });
    expect([odd.json.urgency, odd.json.status]).toEqual([null, "Awaiting Feedback"]);
    // the WO detail hydrates the active todos
    expect((await call("GET", `/work-orders/${id}`)).json.todos.length).toBe(3);

    const done = await call("PATCH", `/work-orders/${id}/todos/${added.json.id}`, { status: "Completed", notes: "shelves ordered" });
    expect(done.json).toMatchObject({ status: "Completed", archived: true, notes: "shelves ordered", assignee: "Renee Castillo" });
    expect((await call("GET", `/work-orders/${id}/todos`)).json.count).toBe(2);
    expect((await call("GET", `/work-orders/${id}/todos?archived=1`)).json.count).toBe(3);
    const reopened = await call("PATCH", `/work-orders/${id}/todos/${added.json.id}`, { status: "Open", assignee: "", priority: "low" });
    expect(reopened.json).toMatchObject({ status: "Open", archived: false, assignee: null, urgency: "low" });
    expect((await call("PATCH", `/work-orders/${id}/todos/${crypto.randomUUID()}`, { title: "x" })).status).toBe(404);
    expect((await call("PATCH", `/work-orders/${woId(1)}/todos/${added.json.id}`, { title: "x" })).status).toBe(404); // wrong WO
    expect((await call("POST", `/work-orders/${id}/todos`, { title: "" })).status).toBe(400);

    // central board
    const board = await call("GET", "/todos");
    expect(Object.keys(board.json)).toEqual(["count", "todos"]);
    expect(board.json.count).toBe(5 + 2); // 5 seeded active + 2 added (one re-opened)
    expect((await call("GET", "/todos?archived=1")).json.count).toBe(8);
    expect((await call("GET", "/todos?assignee=renee%20castillo")).json.count).toBe(3); // seeded; the added one was un-assigned
    expect((await call("GET", "/todos?status=open")).json.count).toBe(4);
    expect((await call("GET", "/todos?urgency=high")).json.count).toBe(2);
    expect((await call("GET", "/todos?urgency=low&assignee=Renee%20Castillo")).json.count).toBe(1);
  });

  // ---- materials --------------------------------------------------------------
  it("materials: list / add / patch (completed, name, notes) / delete", async () => {
    const id = woId(8);
    const list = await call("GET", `/work-orders/${id}/materials?projectId=ignored`);
    expect(list.json.count).toBe(2);
    for (const m of list.json.materials) expect(Object.keys(m)).toEqual(MATERIAL_KEYS);
    const mirrored = list.json.materials.find((m: any) => m.fromRequest);
    expect(mirrored).toMatchObject({ name: "Sonance rock speaker pair (brown)", sourceItem: expect.any(String), sourceItemId: expect.any(String), workOrderId: id });

    const added = await call("POST", `/work-orders/${id}/materials`, { name: "Landscape wire staples", notes: "box of 50" });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ name: "Landscape wire staples", notes: "box of 50", fromRequest: false, sourceItem: null, sourceItemId: null, completed: false, workOrderId: id });
    expect((await call("POST", `/work-orders/${id}/materials`, { name: " " })).status).toBe(400);
    expect((await call("POST", `/work-orders/${crypto.randomUUID()}/materials`, { name: "x" })).status).toBe(404);

    const done = await call("PATCH", `/work-orders/${id}/materials/${added.json.id}`, { completed: true, name: "Landscape wire staples (galv.)", notes: "" });
    expect(done.json).toMatchObject({ completed: true, name: "Landscape wire staples (galv.)", notes: null });
    expect((await call("PATCH", `/work-orders/${id}/materials/${added.json.id}`, { completed: false })).json.completed).toBe(false);
    expect((await call("PATCH", `/work-orders/${id}/materials/${crypto.randomUUID()}`, { completed: true })).status).toBe(404);

    const del = await call("DELETE", `/work-orders/${id}/materials/${added.json.id}`);
    expect(del.json).toEqual({ ok: true });
    expect((await call("GET", `/work-orders/${id}/materials`)).json.count).toBe(2);
    expect((await call("DELETE", `/work-orders/${crypto.randomUUID()}/materials/${added.json.id}`)).status).toBe(404);
  });
});
