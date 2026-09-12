//==============================================================================
// provision.test.ts — round-trip tests for the WO `provision` custom field.
//
// Exercises the REAL service layer (createWorkOrder / getWorkOrder / updateWorkOrder)
// against an in-memory Zoho fake that stores task custom fields the same way Zoho does
// (as top-level keys on the task payload), so provisionFromTask reads back what the
// create/patch writes wrote. Calendar / Cliq / PDF / wonumber are stubbed.
//
// Covers: create -> get, patch -> get, empty-string clear, patch-absent leaves it
// unchanged, and the field-not-yet-created-in-Zoho case (write throws -> non-fatal).
//==============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared in-memory Zoho state (hoisted so the vi.mock factory can close over it).
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
  const state = { seq: 0, failProvisionWrite: false };
  return { tasks, project, state };
});

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
    projectId: rec.projectId ?? "P1",
    projectName: h.project.name,
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
    createTaskList: async (_e: any, _p: string, name: string) => ({
      id: "L1",
      name,
      isCompleted: false,
      raw: {},
    }),
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
      };
      if (opts.description !== undefined) rec.raw.description = opts.description;
      h.tasks.set(rec.id, rec);
      return toZohoTask(rec);
    },
    createSteps: async () => [],
    setWorkOrderField: async (_e: any, _p: string, taskId: string, full: string) => {
      const rec = h.tasks.get(taskId);
      if (rec) {
        rec.workOrderHash = full;
        rec.raw.work_order_hash = full;
      }
    },
    setTaskFields: async (_e: any, _p: string, taskId: string, fields: Record<string, string>) => {
      // Simulate Zoho rejecting a not-yet-created custom field.
      if (h.state.failProvisionWrite && Object.prototype.hasOwnProperty.call(fields, "provision")) {
        throw new ZohoError("Zoho PATCH failed: 400 no such field 'provision'");
      }
      const rec = h.tasks.get(taskId);
      if (!rec) return;
      for (const [k, v] of Object.entries(fields)) {
        rec.raw[k] = v;
        rec.customFields[k] = v;
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
    getTasksByProject: async () => [...h.tasks.values()].map(toZohoTask),
    getSubtasksByProject: async () => [],
    getTaskLists_unused: undefined,
    listPortalTasksByFilter: async (_e: any, filterJson: string) => {
      const filter = JSON.parse(filterJson);
      const crit = filter.criteria?.[0] ?? {};
      if (crit.field_name === "id") {
        const id = crit.value?.[0];
        const rec = h.tasks.get(id);
        return rec ? [toZohoTask(rec)] : [];
      }
      // work_order_hash contains "-WO-" -> every tagged task (Action + Billing).
      return [...h.tasks.values()].filter((r) => r.workOrderHash).map(toZohoTask);
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
  APP_ORIGIN: "https://app.example.com",
  WO_SEQUENCE_SCOPE: "global",
};

const baseInput = { projectId: "P1", subject: "Fix pool light" };

describe("provision field round-trip", () => {
  beforeEach(() => {
    h.tasks.clear();
    h.state.seq = 0;
    h.state.failProvisionWrite = false;
  });

  it("create -> get round-trips a provision URL", async () => {
    const url = "https://provision.example.com/ticket/42";
    const created = await service.createWorkOrder(env, { ...baseInput, provision: url });
    expect(created.provision).toBe(url);

    const fetched = await service.getWorkOrder(env, created.id);
    expect(fetched?.provision).toBe(url);
  });

  it("defaults provision to \"\" when never supplied", async () => {
    const created = await service.createWorkOrder(env, { ...baseInput });
    expect(created.provision).toBe("");
    const fetched = await service.getWorkOrder(env, created.id);
    expect(fetched?.provision).toBe("");
  });

  it("patch -> get updates the provision URL", async () => {
    const created = await service.createWorkOrder(env, { ...baseInput });
    const url = "https://provision.example.com/ticket/99";
    const patched = await service.updateWorkOrder(env, created.id, { provision: url });
    expect(patched?.provision).toBe(url);
    const fetched = await service.getWorkOrder(env, created.id);
    expect(fetched?.provision).toBe(url);
  });

  it("patch with empty string CLEARS provision", async () => {
    const created = await service.createWorkOrder(env, {
      ...baseInput,
      provision: "https://provision.example.com/ticket/7",
    });
    const cleared = await service.updateWorkOrder(env, created.id, { provision: "" });
    expect(cleared?.provision).toBe("");
    const fetched = await service.getWorkOrder(env, created.id);
    expect(fetched?.provision).toBe("");
  });

  it("patch WITHOUT provision leaves the stored value unchanged", async () => {
    const url = "https://provision.example.com/ticket/keep";
    const created = await service.createWorkOrder(env, { ...baseInput, provision: url });
    // Patch an unrelated field (notes) — provision must be untouched.
    const patched = await service.updateWorkOrder(env, created.id, { notes: "new notes" });
    expect(patched?.provision).toBe(url);
    const fetched = await service.getWorkOrder(env, created.id);
    expect(fetched?.provision).toBe(url);
  });

  it("field-absent-from-Zoho: create does not throw; get defaults to \"\"", async () => {
    h.state.failProvisionWrite = true;
    const url = "https://provision.example.com/ticket/nofield";
    // Must NOT throw even though the Zoho custom field doesn't exist yet.
    const created = await service.createWorkOrder(env, { ...baseInput, provision: url });
    expect(created).toBeTruthy();
    // Nothing was persisted (write no-op), so the read-back defaults to "".
    const fetched = await service.getWorkOrder(env, created.id);
    expect(fetched?.provision).toBe("");
  });

  it("field-absent-from-Zoho: patch does not throw", async () => {
    const created = await service.createWorkOrder(env, { ...baseInput });
    h.state.failProvisionWrite = true;
    const patched = await service.updateWorkOrder(env, created.id, {
      provision: "https://provision.example.com/ticket/x",
    });
    expect(patched).toBeTruthy();
    const fetched = await service.getWorkOrder(env, created.id);
    expect(fetched?.provision).toBe("");
  });
});
