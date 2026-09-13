//==============================================================================
// wo-status.test.ts — the redesigned 7-state WO status (hybrid), backward-compatible.
//
// Verifies: default is a scheduling state; setting a manual back-half status (On Hold,
// Ready for Billing, Waiting Payment, Completed) sticks and is mirrored to
// wo_schedule_status; scheduling states auto-derive; the legacy 3-state `status` still
// works and maps to the right woStatus; and the completion gate blocks Ready for Billing
// while an item is unresolved.
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
  class ZohoThrottleError extends ZohoError {}
  const nextId = (p: string) => `${p}${++h.state.seq}`;
  return {
    ZohoError,
    ZohoThrottleError,
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
        customFields: { ...(opts.customFields ?? {}) } as Record<string, string | null>,
        raw: { ...(opts.customFields ?? {}) } as Record<string, unknown>,
        workOrderHash: null as string | null,
        parentTaskId: (opts.parentTaskId ?? null) as string | null,
      };
      if (opts.description !== undefined) rec.raw.description = opts.description;
      h.tasks.set(rec.id, rec);
      return toZohoTask(rec);
    },
    // Generic PATCH: status {id} / is_completed + top-level custom fields (2026-09-09 model).
    patchTask: async (_e: any, _p: string, taskId: string, body: Record<string, unknown>) => {
      const rec = h.tasks.get(taskId);
      if (!rec) return;
      // Live Zoho behaviour (2026-09-09): custom fields can't be edited on a CLOSED task.
      if (rec.isCompleted && Object.keys(body).some((k) => k !== "status" && k !== "is_completed")) {
        throw new ZohoError('Zoho PATCH failed: 400 {"details":[{"message":"cannot update a closed task","field_name":"[wo_task_status]"}]}');
      }
      for (const [k, v] of Object.entries(body)) {
        if (k === "status") { rec.isCompleted = (v as any)?.id === "CLOSED"; continue; }
        if (k === "is_completed") { rec.isCompleted = !!v; continue; }
        rec.raw[k] = v; rec.customFields[k] = v as string;
      }
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
    deleteTask: async (_e: any, _p: string, taskId: string) => {
      h.tasks.delete(taskId);
    },
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
    createPurchaseTask: async (_e: any, input: any) => {
      const initialStatus = input.status && String(input.status).trim() ? String(input.status).trim() : "Needed";
      const parts: string[] = [];
      if (input.note && String(input.note).trim()) parts.push(String(input.note).trim());
      if (input.quantity !== undefined && input.quantity !== null) parts.push(`Qty: ${input.quantity}`);
      const description = parts.join("\n"); // carries the [src-wo-id:<id>] trailer addItem folds in
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
// F3: WorkOrder.hours is hydrated from Postgres (repo/hours.ts). These suites exercise the
// Zoho-side service layer without a database, so the hours repo is an empty in-memory stand-in
// (the same role the old `WO_KV: { get: () => null }` stub played).
vi.mock("../src/repo/hours", () => ({
  getHours: async () => ({ total: 0, entries: [] }),
  appendHoursEntry: async () => ({ total: 0, entries: [] }),
  editHoursEntry: async () => null,
  deleteHoursEntry: async () => null,
}));
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
import { _clearCache } from "../src/cache";

const env: any = {
  ZOHO_WO_FIELD: "work_order_hash",
  ZOHO_PORTAL_ID: "portal",
  ZOHO_PURCHASING_PROJECT_ID: PURCHASING_PROJECT,
  APP_ORIGIN: "https://app.example.com",
  WO_SEQUENCE_SCOPE: "global",
  ZOHO_STATUS_OPEN_ID: "OPEN",
  ZOHO_STATUS_CLOSED_ID: "CLOSED",
};

const baseInput = { projectId: "P1", subject: "Fix pool light" };

describe("7-state WO status (hybrid, backward-compatible)", () => {
  beforeEach(() => {
    h.tasks.clear();
    h.state.seq = 0;
    _clearCache(); // the router invalidates the task scan after every write; tests must too
  });

  it("a new WO defaults to a scheduling state (Not Scheduled)", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    expect(wo.woStatus).toBe("Not Scheduled");
    // legacy status still present
    expect(wo.status).toBe("action");
  });

  it("setting a manual back-half woStatus sticks and mirrors to the field", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const held = await service.updateWorkOrder(env, wo.id, { woStatus: "On Hold" });
    expect(held?.woStatus).toBe("On Hold");
    // persists across a re-fetch (read from wo_schedule_status)
    const refetched = await service.getWorkOrder(env, wo.id);
    expect(refetched?.woStatus).toBe("On Hold");
  });

  it("legacy status:'billing' maps to Ready for Billing; 'completed' to Closed", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const billing = await service.updateWorkOrder(env, wo.id, { status: "billing" });
    expect(billing?.status).toBe("billing");
    expect(billing?.woStatus).toBe("Ready for Billing");

    const completed = await service.updateWorkOrder(env, wo.id, { status: "completed" });
    expect(completed?.woStatus).toBe("Closed");
  });

  // --- Zoho-native status model (2026-09-09) ---------------------------------------
  it("create makes a 'Work Order Status' task tagged with the WO#, wo_cycle_status=Not Scheduled, tasks Pending, billing_status Billable", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const st = [...h.tasks.values()].find((t) => t.name === "Work Order Status");
    expect(st).toBeTruthy();
    expect(st!.workOrderHash).toBe("FHI-672-WO-2026-0001");
    expect(st!.customFields.wo_cycle_status).toBe("Not Scheduled");
    expect(wo.statusTaskId).toBe(st!.id);
    expect(h.tasks.get(wo.actionTaskId)!.customFields.wo_task_status).toBe("Pending");
    const billing = h.tasks.get(wo.billingTaskId!)!;
    expect(billing.customFields.wo_task_status).toBe("Pending");
    expect(billing.customFields.billing_status).toBe("Billable");
    expect(wo.billingStatus).toBe("Billable");
    expect(wo.tasks.map((t) => t.taskStatus)).toEqual(["Pending", "Pending"]);
  });

  it("billable:false at create → Non-Billable; billingStatus patch writes the Billing task field", async () => {
    const wo = await service.createWorkOrder(env, { ...baseInput, billable: false });
    expect(wo.billingStatus).toBe("Non-Billable");
    expect(wo.billable).toBe(false);
    const internal = await service.updateWorkOrder(env, wo.id, { billingStatus: "Internal" });
    expect(internal?.billingStatus).toBe("Internal");
    expect(h.tasks.get(wo.billingTaskId!)!.customFields.billing_status).toBe("Internal");
    const again = await service.getWorkOrder(env, wo.id);
    expect(again?.billingStatus).toBe("Internal");
  });

  it("manual woStatus is stored in wo_cycle_status on the Status task; 'Completed' input normalizes to Closed", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    await service.updateWorkOrder(env, wo.id, { woStatus: "Waiting Payment" });
    expect(h.tasks.get(wo.statusTaskId!)!.customFields.wo_cycle_status).toBe("Waiting Payment");
    const closed = await service.updateWorkOrder(env, wo.id, { woStatus: "Completed" });
    expect(closed?.woStatus).toBe("Closed");
    expect(h.tasks.get(wo.statusTaskId!)!.customFields.wo_cycle_status).toBe("Closed");
    // both tasks Completed + natively closed
    expect(h.tasks.get(wo.actionTaskId)!.customFields.wo_task_status).toBe("Completed");
    expect(h.tasks.get(wo.billingTaskId!)!.customFields.wo_task_status).toBe("Completed");
    expect(h.tasks.get(wo.billingTaskId!)!.isCompleted).toBe(true);
    // board: Closed lands in the "done" bucket, nowhere else
    const done = await service.listWorkOrders(env, { filter: "done", sort: "newest" });
    expect(done.map((w) => w.id)).toContain(wo.id);
    const active = await service.listWorkOrders(env, { filter: "active", sort: "newest" });
    expect(active.map((w) => w.id)).not.toContain(wo.id);
  });

  it("completing the Work Order Tasks task auto-moves the WO to Ready for Billing (even when Non-Billable); reopening returns it to scheduling", async () => {
    const wo = await service.createWorkOrder(env, { ...baseInput, billable: false });
    const r = await service.setTaskStatus(env, wo.id, wo.actionTaskId, "Completed");
    expect(r?.autoPromoted).toBe(true);
    expect(r?.workOrder.woStatus).toBe("Ready for Billing");
    expect(r?.workOrder.tasks.find((t) => t.kind === "work")?.taskStatus).toBe("Completed");
    const back = await service.setTaskStatus(env, wo.id, wo.actionTaskId, "Pending");
    expect(back?.autoPromoted).toBe(false);
    expect(back?.workOrder.woStatus).toBe("Not Scheduled");
  });

  it("promote-on-read: a work task completed directly in Zoho advances the WO on the next detail read", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const rec = h.tasks.get(wo.actionTaskId)!;
    rec.customFields.wo_task_status = "Completed"; rec.raw.wo_task_status = "Completed"; rec.isCompleted = true;
    const read = await service.getWorkOrder(env, wo.id);
    expect(read?.woStatus).toBe("Ready for Billing");
    expect(h.tasks.get(wo.statusTaskId!)!.customFields.wo_cycle_status).toBe("Ready for Billing");
  });

  // F3 (2026-09-13): the KV `billable:<id>` flag is retired with WO_KV (its values are preserved as
  // events by scripts/import-kv.ts, never read by the Worker again). The migration now reports the
  // default billing_status ("Billable") for a legacy WO without one — was "Non-Billable" from KV.
  it("migration: a legacy WO (no Status task) gets one seeded from its current status; Completed → Closed; default billing_status", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    // Strip the new-model bits to simulate a pre-change WO advanced to "Completed" the old way
    // (Action task closed; Billing left open so its fields are writable).
    h.tasks.delete(wo.statusTaskId!);
    for (const id of [wo.actionTaskId, wo.billingTaskId!]) {
      const t = h.tasks.get(id)!;
      delete t.customFields.wo_task_status; delete t.raw.wo_task_status;
      delete t.customFields.billing_status; delete t.raw.billing_status;
    }
    h.tasks.get(wo.actionTaskId)!.isCompleted = true;
    h.tasks.get(wo.actionTaskId)!.raw.wo_schedule_status = "Completed";
    const legacyEnv = { ...env };

    const dry = await service.migrateStatusModel(legacyEnv, { apply: false, limit: 10 });
    expect(dry.dryRun).toBe(true);
    expect(dry.pending).toBe(1);
    expect(dry.rows[0]).toMatchObject({ hasStatusTask: false, fromStatus: "Closed", toStatus: "Closed", billingStatus: "Billable", workTaskStatus: "Completed", billingTaskStatus: "Pending" });
    // the closed Action task's field write is skipped (Zoho refuses it; the read falls back to Completed)
    expect(dry.rows[0].needs).toEqual(["status-task", "billing-task-status", "billing-status"]);
    expect(dry.rows[0].skippedClosed).toEqual(["work-task-status"]);

    const applied = await service.migrateStatusModel(legacyEnv, { apply: true, limit: 10 });
    expect(applied.processed).toBe(1);
    expect(applied.pending).toBe(0);
    const st = [...h.tasks.values()].find((t) => t.name === "Work Order Status")!;
    expect(st.customFields.wo_cycle_status).toBe("Closed");
    expect(st.workOrderHash).toBe("FHI-672-WO-2026-0001");
    expect(h.tasks.get(wo.billingTaskId!)!.customFields.billing_status).toBe("Billable");
    expect(h.tasks.get(wo.actionTaskId)!.customFields.wo_task_status).toBeUndefined();
    expect(h.tasks.get(wo.billingTaskId!)!.customFields.wo_task_status).toBe("Pending");
    // idempotent
    const again = await service.migrateStatusModel(legacyEnv, { apply: false, limit: 10 });
    expect(again.pending).toBe(0);
    const read = await service.getWorkOrder(legacyEnv, wo.id);
    expect(read?.woStatus).toBe("Closed");
    expect(read?.billingStatus).toBe("Billable");
    expect(read?.tasks.find((t) => t.kind === "work")?.taskStatus).toBe("Completed"); // fallback from the closed flag
  });

  it("writing a task field on a CLOSED task reopens it first (Zoho refuses field edits on closed tasks)", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    await service.updateWorkOrder(env, wo.id, { woStatus: "Waiting Payment" }); // Action closed
    expect(h.tasks.get(wo.actionTaskId)!.isCompleted).toBe(true);
    const closed = await service.updateWorkOrder(env, wo.id, { woStatus: "Closed" }); // rewrites Completed on the closed Action
    expect(closed?.woStatus).toBe("Closed");
    expect(h.tasks.get(wo.actionTaskId)!.isCompleted).toBe(true);
    const back = await service.updateWorkOrder(env, wo.id, { woStatus: "Scheduled" }); // Pending on two closed tasks
    expect(h.tasks.get(wo.actionTaskId)!.isCompleted).toBe(false);
    expect(h.tasks.get(wo.actionTaskId)!.customFields.wo_task_status).toBe("Pending");
    expect(back?.woStatus).toBe("Not Scheduled");
  });

  it("woStatus 'Ready for Billing' runs the items completion gate", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    await service.addItem(env, wo.id, { item: "Amp", status: "Needed" }); // unresolved

    await expect(service.updateWorkOrder(env, wo.id, { woStatus: "Ready for Billing" })).rejects.toThrow(
      /part\(s\) still pending|not marked installed/
    );

    // resolve the item, then it passes
    const items = await service.listItemsForWo(env, wo.id);
    await service.updatePurchase(env, items[0].id, { status: "Installed (From Stock)" });
    const ok = await service.updateWorkOrder(env, wo.id, { woStatus: "Ready for Billing" });
    expect(ok?.woStatus).toBe("Ready for Billing");
  });

  it("moving back to a scheduling woStatus clears the manual state (auto derivation resumes)", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    await service.updateWorkOrder(env, wo.id, { woStatus: "On Hold" });
    const back = await service.updateWorkOrder(env, wo.id, { woStatus: "Not Scheduled" });
    // no visits -> auto derives Not Scheduled
    expect(back?.woStatus).toBe("Not Scheduled");
  });
});

describe("visits as legible Schedule subtasks (round-trip)", () => {
  beforeEach(() => {
    h.tasks.clear();
    h.state.seq = 0;
    _clearCache(); // the router invalidates the task scan after every write; tests must too
  });

  const sched = { start: "2026-08-24T10:30:00-04:00", end: "2026-08-24T14:30:00-04:00", attendees: ["craig@fhiflorida.com"] };

  it("createWorkOrder with a schedule stores a visit subtask (no base64 in the description)", async () => {
    const wo = await service.createWorkOrder(env, { ...baseInput, schedule: sched });
    expect(wo.visits).toHaveLength(1);
    expect(wo.visits[0]).toMatchObject({ start: sched.start, end: sched.end, attendees: sched.attendees, eventId: "ev1" });

    // Re-fetch reads visits back from the Schedule subtask.
    const fetched = await service.getWorkOrder(env, wo.id);
    expect(fetched?.visits).toHaveLength(1);
    expect(fetched?.visits[0].start).toBe(sched.start);

    // The Action task description carries NO base64 visits trailer.
    const action = h.tasks.get(wo.id);
    expect(String(action?.description ?? "")).not.toContain("fhi-visits-v1:");
    // A "Schedule" container task exists.
    expect([...h.tasks.values()].some((t) => t.name === "Schedule")).toBe(true);
  });

  it("addVisit / updateVisit / removeVisit operate on subtasks", async () => {
    const wo = await service.createWorkOrder(env, baseInput); // no initial visit
    const added = await service.addVisit(env, wo.id, {
      start: "2026-08-25T09:00:00-04:00",
      end: "2026-08-25T11:00:00-04:00",
      attendees: ["tech@fhiflorida.com"],
      label: "Day 1",
    });
    expect(added?.visits).toHaveLength(1);
    const visitId = added!.visits[0].id;
    expect(added!.visits[0].label).toBe("Day 1");

    const updated = await service.updateVisit(env, wo.id, visitId, { label: "Return trip" });
    expect(updated?.visits[0].label).toBe("Return trip");
    // persisted
    const refetch = await service.getWorkOrder(env, wo.id);
    expect(refetch?.visits[0].label).toBe("Return trip");

    const removed = await service.removeVisit(env, wo.id, visitId);
    expect(removed?.visits).toHaveLength(0);
  });
});

describe("to-dos read via work_order_hash filter (not has_parents)", () => {
  beforeEach(() => {
    h.tasks.clear();
    h.state.seq = 0;
    _clearCache(); // the router invalidates the task scan after every write; tests must too
  });

  it("an added todo appears on the WO and the central dashboard; Completed archives it", async () => {
    const wo = await service.createWorkOrder(env, baseInput);
    const todo = await service.addTodo(env, wo.id, { title: "Order panel", assignee: "craig@fhiflorida.com" });
    expect(todo?.id).toBeTruthy();

    // per-WO list (listTodos → reuses the portal filter)
    const woTodos = await service.listTodos(env, wo.id);
    expect(woTodos.map((t) => t.title)).toContain("Order panel");

    // central dashboard (listAllTodos → the fixed work_order_hash portal query)
    const all = await service.listAllTodos(env, {});
    expect(all.some((t) => t.id === todo!.id)).toBe(true);

    // Completed → archived off the active dashboard, still visible with includeArchived
    await service.updateTodo(env, wo.id, todo!.id, { status: "Completed" });
    const active = await service.listAllTodos(env, {});
    expect(active.some((t) => t.id === todo!.id)).toBe(false);
    const withArchived = await service.listAllTodos(env, { includeArchived: true });
    expect(withArchived.some((t) => t.id === todo!.id)).toBe(true);
  });
});
