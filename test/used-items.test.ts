//==============================================================================
// used-items.test.ts — the unified "installed / billable" used-items contract.
//
// Exercises the REAL service layer against an in-memory Zoho fake (same style as
// provision.test.ts). Covers:
//   - GET returns installed / source / sourcePartId on every used item (with defaults
//     back-filled on legacy rows).
//   - manual add defaults installed:false, source:"manual", sourcePartId:null.
//   - PATCH used-items/:itemId flips a manual item to installed and it persists.
//   - marking a part "Installed" auto-creates a used item on the source WO
//     (source:"part", installed:true, sourcePartId = part id); doing it twice does
//     NOT duplicate; moving OFF Installed flips the linked row to installed:false.
//==============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  interface Rec {
    id: string;
    name: string;
    taskListId: string | null;
    projectId: string;
    description: string | null;
    priority: string | null;
    isCompleted: boolean;
    customFields: Record<string, string | null>;
    raw: Record<string, unknown>;
    workOrderHash: string | null;
    parentTaskId?: string | null;
  }
  const tasks = new Map<string, Rec>();
  const project = {
    id: "P1",
    name: "Acme, John - 123 Main St - SERVICE",
    key: "FHI-672",
    siteAddress: "123 Main St",
    siteCity: null,
    siteState: null,
    siteZip: null,
    customFields: {} as Record<string, string | null>,
    raw: {} as Record<string, unknown>,
  };
  const state = { seq: 0 };
  return { tasks, project, state };
});

const PURCHASING_PROJECT = "PURCH1";

function toZohoTask(rec: any) {
  return {
    id: rec.id,
    name: rec.name,
    description: rec.description ?? null,
    isCompleted: rec.isCompleted,
    statusName: null,
    priority: rec.priority ?? null,
    taskListId: rec.taskListId ?? null,
    customFields: rec.customFields,
    createdAt: null,
    updatedAt: null,
    raw: rec.raw,
    workOrderHash: rec.workOrderHash ?? null,
    parentTaskId: rec.parentTaskId ?? null,
    projectId: rec.projectId ?? "P1",
    projectName: rec.projectId === PURCHASING_PROJECT ? "FHI-907 Purchasing" : h.project.name,
    taskListName: "WO-2026-0001 - Fix pool light",
    createdTime: null,
    lastModifiedTime: null,
  };
}

vi.mock("../src/zoho", () => {
  class ZohoError extends Error {}
  const nextId = (p: string) => `${p}${++h.state.seq}`;
  return {
    ZohoError,
    getProject: async () => h.project,
    getAccessCodes: async () => ({ gate_code: null, community_gate: null, door_code: null }),
    updateAccessCodes: async () => {},
    createTaskList: async (_e: any, _p: string, name: string) => ({ id: "L1", name, isCompleted: false, raw: {} }),
    updateTaskList: async () => {},
    getTaskLists: async () => [{ id: "L1", name: "L1", isCompleted: false, raw: {} }],
    createTask: async (_e: any, projectId: string, opts: any) => {
      const rec = {
        id: nextId("T"),
        name: opts.name,
        taskListId: opts.taskListId || "L1",
        projectId,
        description: opts.description ?? null,
        priority: opts.priority ?? null,
        isCompleted: false,
        customFields: {} as Record<string, string | null>,
        raw: {} as Record<string, unknown>,
        workOrderHash: null as string | null,
        parentTaskId: (opts.parentTaskId ?? null) as string | null,
      };
      if (opts.description !== undefined) rec.raw.description = opts.description;
      h.tasks.set(rec.id, rec);
      return toZohoTask(rec);
    },
    getSubtasksByProject: async (_e: any, projectId: string) =>
      [...h.tasks.values()].filter((r) => r.projectId === projectId && r.parentTaskId).map(toZohoTask),
    getPortalSubtasks: async () => [...h.tasks.values()].filter((r) => r.parentTaskId).map(toZohoTask),
    createSteps: async () => [],
    setWorkOrderField: async (_e: any, _p: string, taskId: string, full: string) => {
      const rec = h.tasks.get(taskId);
      if (rec) {
        rec.workOrderHash = full;
        rec.raw.work_order_hash = full;
      }
    },
    setTaskFields: async (_e: any, _p: string, taskId: string, fields: Record<string, string>) => {
      const rec = h.tasks.get(taskId);
      if (!rec) return;
      for (const [k, v] of Object.entries(fields)) {
        rec.raw[k] = v;
        rec.customFields[k] = v;
        // Mirror real Zoho: work_order_hash populates the top-level workOrderHash.
        if (k === "work_order_hash") rec.workOrderHash = v;
        if (k === "name") rec.name = v;
      }
    },
    setTaskDescription: async (_e: any, _p: string, taskId: string, description: string) => {
      const rec = h.tasks.get(taskId);
      if (rec) {
        rec.description = description;
        rec.raw.description = description;
      }
    },
    setTaskCompleted: async (_e: any, _p: string, taskId: string, completed: boolean) => {
      const rec = h.tasks.get(taskId);
      if (rec) rec.isCompleted = completed;
    },
    getTask: async (_e: any, _p: string, taskId: string) => toZohoTask(h.tasks.get(taskId)),
    getTasksByProject: async (_e: any, projectId: string) =>
      [...h.tasks.values()].filter((r) => r.projectId === projectId).map(toZohoTask),
    listPortalTasksByFilter: async (_e: any, filterJson: string) => {
      const filter = JSON.parse(filterJson);
      const crit = filter.criteria?.[0] ?? {};
      if (crit.field_name === "id") {
        const rec = h.tasks.get(crit.value?.[0]);
        return rec ? [toZohoTask(rec)] : [];
      }
      return [...h.tasks.values()].filter((r) => r.workOrderHash).map(toZohoTask);
    },
    // --- Purchasing helpers ---
    createPurchaseTask: async (_e: any, input: any) => {
      const parts: string[] = [];
      if (input.note && input.note.trim()) parts.push(input.note.trim());
      if (input.quantity !== undefined && input.quantity !== null) parts.push(`Qty: ${input.quantity}`);
      const description = parts.join("\n");
      const initialStatus = input.status && String(input.status).trim() ? String(input.status).trim() : "Needed";
      const rec = {
        id: nextId("PT"),
        name: input.item,
        taskListId: "PL1",
        projectId: PURCHASING_PROJECT,
        description,
        priority: null,
        isCompleted: false,
        customFields: { order_status: initialStatus } as Record<string, string | null>,
        raw: { order_status: initialStatus, description } as Record<string, unknown>,
        workOrderHash: input.sourceWo ?? null,
      };
      if (input.sourceWo) rec.raw.work_order_hash = input.sourceWo;
      h.tasks.set(rec.id, rec);
      return toZohoTask(rec);
    },
    listPurchaseTasks: async () =>
      [...h.tasks.values()].filter((r) => r.projectId === PURCHASING_PROJECT).map(toZohoTask),
    updatePurchaseTask: async (_e: any, taskId: string, fields: any) => {
      const rec = h.tasks.get(taskId);
      if (!rec) return;
      if (fields.status) {
        rec.raw.order_status = fields.status;
        rec.customFields.order_status = fields.status;
      }
      if (fields.description !== undefined) {
        rec.description = fields.description;
        rec.raw.description = fields.description;
      }
    },
    isServiceProject: () => true,
    searchProjects: async () => [h.project],
    _clearTokenCache: () => {},
  };
});

vi.mock("../src/calendar", () => ({
  CalendarError: class extends Error {},
  buildEventBody: () => ({}),
  insertEvent: async () => ({ id: "ev1", htmlLink: null }),
  patchEvent: async () => ({ id: "ev1", htmlLink: null }),
  deleteEvent: async () => {},
  listEvents: async () => [],
}));
vi.mock("../src/cliq", () => ({ postToCliq: async () => {} }));
vi.mock("../src/pdf", () => ({ buildDailyReportPdf: () => new Uint8Array(), buildTextPdf: () => new Uint8Array() }));
vi.mock("../src/wonumber", () => ({
  mintWorkOrderNumber: async () => ({
    full: "FHI-672-WO-2026-0001",
    projectKey: "FHI-672",
    mintedRef: "2026-0001",
    year: 2026,
    seq: 1,
  }),
  parseWoNumber: (full: string) => {
    const m = full.match(/^(.*)-WO-(\d{4})-(\d+)$/);
    if (!m) return null;
    return { full, projectKey: m[1], mintedRef: `${m[2]}-${m[3]}`, year: +m[2], seq: +m[3] };
  },
}));

import * as service from "../src/service";

const env: any = {
  WO_KV: { get: async () => null, put: async () => {} },
  ZOHO_WO_FIELD: "work_order_hash",
  ZOHO_PORTAL_ID: "portal",
  ZOHO_PURCHASING_PROJECT_ID: PURCHASING_PROJECT,
  APP_ORIGIN: "https://app.example.com",
  WO_SEQUENCE_SCOPE: "global",
};

const baseInput = { projectId: "P1", subject: "Fix pool light" };

describe("used-items installed/billable contract", () => {
  beforeEach(() => {
    h.tasks.clear();
    h.state.seq = 0;
  });

  it("manual add defaults installed:false, source:manual, sourcePartId:null", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const after = await service.addUsedItem(env, wo.id, { item: "HDMI cable", quantity: 2 });
    expect(after?.usedItems).toHaveLength(1);
    const ui = after!.usedItems[0];
    expect(ui.installed).toBe(false);
    expect(ui.source).toBe("manual");
    expect(ui.sourcePartId).toBeNull();

    // GET round-trips the fields.
    const fetched = await service.getWorkOrder(env, wo.id);
    expect(fetched?.usedItems[0]).toMatchObject({ installed: false, source: "manual", sourcePartId: null });
  });

  it("PATCH used-items/:itemId flips a manual item to installed and persists", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const added = await service.addUsedItem(env, wo.id, { item: "Keypad" });
    const itemId = added!.usedItems[0].id;

    const patched = await service.patchUsedItem(env, wo.id, itemId, { installed: true, quantity: 3 });
    expect(patched?.usedItems[0].installed).toBe(true);
    expect(patched?.usedItems[0].quantity).toBe(3);

    const fetched = await service.getWorkOrder(env, wo.id);
    expect(fetched?.usedItems[0].installed).toBe(true);
    expect(fetched?.usedItems[0].quantity).toBe(3);
  });

  it("marking an item Installed writes NO used-item JSON blob (item IS the record)", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const part = await service.requestItem(env, wo.id, { item: "Motion sensor", quantity: 4 });
    const partId = part!.id;

    await service.updatePurchase(env, partId, { status: "Installed" });
    await service.updatePurchase(env, partId, { status: "Installed" }); // twice

    // The interim auto-create sync is retired: no wo_used_items rows are written.
    const fetched = await service.getWorkOrder(env, wo.id);
    expect(fetched!.usedItems.filter((i) => i.source === "part")).toHaveLength(0);
    // The item itself reflects the installed status via the items list.
    const items = await service.listItemsForWo(env, wo.id);
    expect(items.find((i) => i.id === partId)?.status).toBe("Installed");
  });

  it("Not Needed / Canceled write NO used-item blob either", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const p1 = await service.requestItem(env, wo.id, { item: "Extra bracket" });
    const p2 = await service.requestItem(env, wo.id, { item: "Wrong part" });

    await service.updatePurchase(env, p1!.id, { status: "Not Needed" });
    await service.updatePurchase(env, p2!.id, { status: "Canceled" });

    const fetched = await service.getWorkOrder(env, wo.id);
    expect(fetched!.usedItems.filter((i) => i.source === "part")).toHaveLength(0);
  });

  it("DONE statuses (Installed / Not Needed / Cancelled) archive the part; pending do not", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const installed = await service.requestItem(env, wo.id, { item: "Camera" });
    const notNeeded = await service.requestItem(env, wo.id, { item: "Spare" });
    const cancelled = await service.requestItem(env, wo.id, { item: "Oops" });
    const pending = await service.requestItem(env, wo.id, { item: "Cable" });

    await service.updatePurchase(env, installed!.id, { status: "Installed" });
    await service.updatePurchase(env, notNeeded!.id, { status: "Not Needed" });
    await service.updatePurchase(env, cancelled!.id, { status: "Cancelled" });
    await service.updatePurchase(env, pending!.id, { status: "On Order" });

    // Active list (default) excludes the three DONE items, keeps the pending one.
    const active = await service.listPurchasing(env);
    const activeIds = active.map((p) => p.id);
    expect(activeIds).toContain(pending!.id);
    expect(activeIds).not.toContain(installed!.id);
    expect(activeIds).not.toContain(notNeeded!.id);
    expect(activeIds).not.toContain(cancelled!.id);

    // includeArchived returns all four, with archived flags set correctly.
    const all = await service.listPurchasing(env, undefined, true);
    const byId = Object.fromEntries(all.map((p) => [p.id, p]));
    expect(byId[installed!.id].archived).toBe(true);
    expect(byId[notNeeded!.id].archived).toBe(true);
    expect(byId[cancelled!.id].archived).toBe(true);
    expect(byId[pending!.id].archived).toBe(false);
  });

  it("new 7-status vocabulary: both Installed variants archive; Staged/On Order stay active; no used-item blob", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const stock = await service.requestItem(env, wo.id, { item: "Speaker" });
    const field = await service.requestItem(env, wo.id, { item: "Adapter" });
    const staged = await service.requestItem(env, wo.id, { item: "Panel" });
    const onOrder = await service.requestItem(env, wo.id, { item: "Bracket" });

    await service.updatePurchase(env, stock!.id, { status: "Installed (From Stock)" });
    await service.updatePurchase(env, field!.id, { status: "Installed (Field Purchase)" });
    await service.updatePurchase(env, staged!.id, { status: "Staged" });
    await service.updatePurchase(env, onOrder!.id, { status: "On Order" });

    // Active board excludes the two Installed, keeps Staged + On Order.
    const activeIds = (await service.listPurchasing(env)).map((p) => p.id);
    expect(activeIds).toContain(staged!.id);
    expect(activeIds).toContain(onOrder!.id);
    expect(activeIds).not.toContain(stock!.id);
    expect(activeIds).not.toContain(field!.id);

    // No wo_used_items blob is written — the item's status is the record.
    const fetched = await service.getWorkOrder(env, wo.id);
    expect(fetched!.usedItems.filter((i) => i.source === "part")).toHaveLength(0);
  });

  it("close-out gate: billing is blocked while a used item is not marked installed", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const added = await service.addUsedItem(env, wo.id, { item: "Thermostat" });
    const itemId = added!.usedItems[0].id;

    await expect(service.updateWorkOrder(env, wo.id, { status: "billing" })).rejects.toThrow(
      /not marked installed/
    );

    // After marking it installed, the WO can move to billing.
    await service.patchUsedItem(env, wo.id, itemId, { installed: true });
    const billed = await service.updateWorkOrder(env, wo.id, { status: "billing" });
    expect(billed).toBeTruthy();
  });

  it("unified Items: addItem defaults to Needed and posts; installed status skips the request post", async () => {
    const wo = await service.createWorkOrder(env, baseInput);

    const needed = await service.addItem(env, wo.id, { item: "Receiver", quantity: 1 });
    expect(needed!.status).toBe("Needed");
    expect(needed!.sourceWoId).toBe(wo.id);

    const used = await service.addItem(env, wo.id, {
      item: "Wire nut",
      quantity: 10,
      status: "Installed (From Stock)",
    });
    expect(used!.status).toBe("Installed (From Stock)");

    // listItemsForWo returns BOTH (any status).
    const items = await service.listItemsForWo(env, wo.id);
    expect(items.map((i) => i.item).sort()).toEqual(["Receiver", "Wire nut"]);
    // The installed one is terminal (archived), the needed one is active.
    const byName = Object.fromEntries(items.map((i) => [i.item, i]));
    expect(byName["Wire nut"].archived).toBe(true);
    expect(byName["Receiver"].archived).toBe(false);
  });

  it("back-fills defaults on a legacy used item stored without the new fields", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    // Simulate a pre-contract row: only the original fields present.
    const legacy = [{ id: "legacy1", item: "Old wire", quantity: 5, note: null, at: "2026-01-01T00:00:00Z", by: null }];
    const rec = h.tasks.get(wo.id)!;
    rec.raw.wo_used_items = JSON.stringify(legacy);

    const fetched = await service.getWorkOrder(env, wo.id);
    expect(fetched?.usedItems[0]).toMatchObject({
      id: "legacy1",
      installed: false,
      source: "manual",
      sourcePartId: null,
    });
  });
});
