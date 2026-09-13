//==============================================================================
// pg-items.test.ts — unified Items on the Postgres path (P2): the per-WO list,
// the purchasing aggregate (GET /items), the 6-state vocabulary + archiving,
// the Materials mirror and the completion gate. Real router, sandbox tenant.
//==============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { callApi, countSandboxEvents, resetSandboxForTests, sandboxAvailable, sandboxEnv } from "./_sandbox";

const up = await sandboxAvailable();
const woId = (n: number) => `f4200006-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ITEM_KEYS = ["id", "item", "quantity", "note", "status", "sourceWo", "sourceWoId", "archived", "createdAt", "custom"];

describe.skipIf(!up)("Postgres items (sandbox tenant)", () => {
  let env: Env;
  const call = (method: string, path: string, body?: unknown) => callApi(worker, env, method, path, body);

  beforeAll(async () => {
    await resetSandboxForTests();
    env = sandboxEnv();
  });

  it("GET /items is the purchasing aggregate: active by default, ?archived=1 for all, ?status= case-insensitive", async () => {
    const active = await call("GET", "/items");
    expect(active.status).toBe(200);
    expect(Object.keys(active.json)).toEqual(["count", "items"]);
    expect(active.json.count).toBe(15);
    expect(active.json.items.every((i: any) => i.archived === false)).toBe(true);
    for (const i of active.json.items) expect(Object.keys(i)).toEqual(ITEM_KEYS);
    const all = await call("GET", "/items?archived=1");
    expect(all.json.count).toBe(20);
    const byStatus = (s: string) => all.json.items.filter((i: any) => i.status === s).length;
    expect([byStatus("Needed"), byStatus("On Order"), byStatus("Staged"), byStatus("Backordered"), byStatus("Installed (From Stock)"), byStatus("Installed (Field Purchase)"), byStatus("Canceled")]).toEqual([6, 3, 5, 1, 2, 2, 1]);
    expect(all.json.items.filter((i: any) => i.archived).map((i: any) => i.status).sort()).toEqual(["Canceled", "Installed (Field Purchase)", "Installed (Field Purchase)", "Installed (From Stock)", "Installed (From Stock)"]);
    expect((await call("GET", "/items?status=needed")).json.count).toBe(6);
    expect((await call("GET", "/items?status=ON%20ORDER")).json.count).toBe(3);
    expect((await call("GET", "/items?status=installed%20(from%20stock)")).json.count).toBe(0); // archived → excluded by default
    expect((await call("GET", "/items?status=installed%20(from%20stock)&archived=1")).json.count).toBe(2);
    // every row deep-links to its WO by uuid and carries the WO number
    const one = all.json.items.find((i: any) => i.item === "Epson ELPLP lamp");
    expect(one).toMatchObject({ sourceWo: "GS-106-WO-2026-0007", sourceWoId: woId(7), status: "Backordered", quantity: 1, archived: false, custom: {} });
  });

  it("GET /work-orders/:id/items lists the WO's items in EVERY status, oldest first", async () => {
    const r = await call("GET", `/work-orders/${woId(19)}/items`);
    expect(r.json.count).toBe(4);
    expect(r.json.items.every((i: any) => i.sourceWoId === woId(19) && i.status === "Needed")).toBe(true);
    const wo3 = await call("GET", `/work-orders/${woId(3)}/items`);
    expect(wo3.json.items.map((i: any) => i.archived)).toEqual([true, true]);
    expect((await call("GET", `/work-orders/${crypto.randomUUID()}/items`)).json).toEqual({ count: 0, items: [] });
  });

  it("POST /work-orders/:id/items adds an item (default Needed), mirrors a Material, appends events", async () => {
    const id = woId(25);
    const before = await countSandboxEvents("item.created");
    const r = await call("POST", `/work-orders/${id}/items`, { item: "16V 30VA transformer", quantity: 1, note: "Ring spec", custom: {} });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json)).toEqual(ITEM_KEYS);
    expect(r.json).toMatchObject({ item: "16V 30VA transformer", quantity: 1, note: "Ring spec", status: "Needed", sourceWo: "GS-102-WO-2026-0025", sourceWoId: id, archived: false, custom: {} });
    const mats = await call("GET", `/work-orders/${id}/materials`);
    expect(mats.json.count).toBe(1);
    expect(mats.json.materials[0]).toMatchObject({ name: "16V 30VA transformer", notes: "Ring spec", fromRequest: true, sourceItem: "16V 30VA transformer ×1", sourceItemId: r.json.id, completed: false, workOrderId: id });
    expect(await countSandboxEvents("item.created")).toBe(before + 1);
    // an initial terminal status archives at once (a tech logging something used off the truck)
    const used = await call("POST", `/work-orders/${id}/items`, { item: "Wire nuts", status: "Installed (From Stock)" });
    expect(used.json.archived).toBe(true);
    expect((await call("GET", `/work-orders/${id}/items`)).json.count).toBe(3); // seeded Ring chime kit + 2
    expect((await call("GET", "/items")).json.items.some((i: any) => i.id === used.json.id)).toBe(false);
    expect((await call("POST", `/work-orders/${id}/items`, { quantity: 1 })).status).toBe(400);
    expect((await call("POST", `/work-orders/${crypto.randomUUID()}/items`, { item: "x" })).status).toBe(404);
  });

  it("PATCH /items/:id walks the 6-state vocabulary: terminal statuses archive, non-terminal ones un-archive; note/quantity/custom edit", async () => {
    const id = woId(25);
    const created = (await call("GET", `/work-orders/${id}/items`)).json.items.find((i: any) => i.item === "16V 30VA transformer");
    const expectStatus = async (status: string, archived: boolean) => {
      const r = await call("PATCH", `/items/${created.id}`, { status });
      expect(r.status).toBe(200);
      expect([r.json.status, r.json.archived]).toEqual([status, archived]);
    };
    await expectStatus("On Order", false);
    await expectStatus("Backordered", false);
    await expectStatus("Staged", false);
    await expectStatus("Installed (Field Purchase)", true);
    await expectStatus("Needed", false); // re-opened
    await expectStatus("Canceled", true);
    await expectStatus("Installed (From Stock)", true);
    // an unknown label is accepted (vocab auto-created), not rejected — the Zoho path passed strings through
    await expectStatus("Quoted", false);
    const edited = await call("PATCH", `/items/${created.id}`, { note: "Ordered from ADI", quantity: 2 });
    expect(edited.json).toMatchObject({ note: "Ordered from ADI", quantity: 2, status: "Quoted" });
    expect((await call("PATCH", `/items/${created.id}`, { status: "" })).status).toBe(400);
    expect((await call("PATCH", `/items/${crypto.randomUUID()}`, { status: "Needed" })).status).toBe(404);
    expect((await call("PATCH", `/items/${created.id}`, { custom: { nope: 1 } })).status).toBe(400);
  });

  it("the completion gate reads the same rows: resolving every item unblocks Ready for Billing", async () => {
    const id = woId(25);
    const items = (await call("GET", `/work-orders/${id}/items`)).json.items;
    const blocked = await call("PATCH", `/work-orders/${id}`, { woStatus: "Ready for Billing" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatch(/2 requested part\(s\) still pending/); // Ring chime kit + the Quoted one
    for (const i of items.filter((x: any) => !x.archived)) await call("PATCH", `/items/${i.id}`, { status: "Installed (From Stock)" });
    const ok = await call("PATCH", `/work-orders/${id}`, { woStatus: "Ready for Billing" });
    expect(ok.status).toBe(200);
    expect(ok.json.woStatus).toBe("Ready for Billing");
  });

  it("DELETE /items/:id soft-deletes (idempotent) and drops the row from every list", async () => {
    const id = woId(19);
    const items = (await call("GET", `/work-orders/${id}/items`)).json.items;
    const target = items[0];
    const r = await call("DELETE", `/items/${target.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: true, id: target.id });
    expect((await call("GET", `/work-orders/${id}/items`)).json.count).toBe(3);
    expect((await call("GET", "/items?archived=1")).json.items.some((i: any) => i.id === target.id)).toBe(false);
    expect((await call("PATCH", `/items/${target.id}`, { status: "Needed" })).status).toBe(404);
    expect((await call("DELETE", `/items/${target.id}`)).status).toBe(200); // idempotent, as before
    expect((await call("DELETE", "/items/not-a-uuid")).status).toBe(200);
  });
});
