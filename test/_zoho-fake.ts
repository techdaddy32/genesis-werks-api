//==============================================================================
// _zoho-fake.ts — the in-memory Zoho stand-in the service suites use, lifted out
// of used-items.test.ts so route-level suites can share it:
//   vi.mock("../src/zoho", async () => (await import("./_zoho-fake")).zohoFake);
// Not a test file. State lives in `h`; call reset() in beforeEach.
//==============================================================================
/* eslint-disable @typescript-eslint/no-explicit-any */

export const h = (() => {
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
})();

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

export const zohoFake = (() => {
  class ZohoError extends Error {}
  // service.ts checks `instanceof ZohoThrottleError` on every task-status write (throttle
  // → rethrow, else closed-task reopen); the mock must export it like wo-status.test.ts does.
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
    // writeTaskStatus() (wo_task_status + native open/closed in ONE PATCH) goes through
    // patchTask since 2026-09-09; mirror wo-status.test.ts' fake, incl. the closed-task refusal.
    patchTask: async (_e: any, _p: string, taskId: string, body: Record<string, unknown>) => {
      const rec = h.tasks.get(taskId);
      if (!rec) return;
      if (rec.isCompleted && Object.keys(body).some((k) => k !== "status" && k !== "is_completed")) {
        throw new ZohoError('Zoho PATCH failed: 400 {"details":[{"message":"cannot update a closed task","field_name":"[wo_task_status]"}]}');
      }
      for (const [k, v] of Object.entries(body)) {
        if (k === "status") { rec.isCompleted = (v as any)?.id === "CLOSED"; continue; }
        if (k === "is_completed") { rec.isCompleted = !!v; continue; }
        rec.raw[k] = v; rec.customFields[k] = v as string;
      }
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
})();


export function reset(): void {
  h.tasks.clear();
  h.state.seq = 0;
}
