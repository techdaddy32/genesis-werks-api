//==============================================================================
// repo/work-orders.ts — work orders on Postgres (P2): the WRITE side + the
// list/detail handlers service.ts dispatches to for a Postgres-backed tenant.
//
//   POST   /work-orders                 → createWorkOrder()   mint key (keys.ts) + work/billing tasks (+ steps) + first visit
//   GET    /work-orders?filter&sort&q&schedule → listWorkOrders()  (status.ts filter/sort/search — one source)
//   GET    /work-orders/:id             → getWorkOrder()
//   PATCH  /work-orders/:id             → updateWorkOrder()   notes / priority / codes / status / schedule / urls / custom
//   DELETE /work-orders/:id             → deleteWorkOrder()   soft delete (+ Google events when configured)
//   PATCH  /work-orders/:id/tasks/:tid  → setTaskStatus()     work / billing / step tasks; auto-promote rule
//
// Business rules live HERE (§8.9 — none in the DB, none on the read path):
//   - status ↔ task coupling (data-model §5 "status ↔ task-status coupling")
//   - the items completion gate (409 CompletionGateError) on billing/completed targets
//   - auto-promote to Ready for Billing when the work task completes pre-billing
//     (write-side only; the Zoho path's promote-on-read is deliberately NOT ported)
// Derived fields (lifecycle / scheduleStatus / woStatus) come from the 0001
// views on reload (repo/wo-read.ts). Every write appends an events row.
// `custom` (entity "work_orders") is validated on create + patch.
//==============================================================================

import type {
  CreateWorkOrderInput,
  Env,
  ScheduleStatus,
  TaskStatusResult,
  UpdateWorkOrderInput,
  WorkOrder,
  WorkOrderFilter,
  WorkOrderSort,
  WorkOrderStatus,
} from "../types";
import { isUuid, withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { mintPublicKey } from "../keys";
import { BILLING_STATUSES, DEFAULT_BILLING_STATUS, TASK_STATUS_COMPLETED, TASK_STATUS_PENDING } from "../config";
import {
  CYCLE_STATUS_LABEL,
  deriveScheduleStatus,
  isBackHalfStatus,
  isPreBillingStatus,
  lifecycleOfWoStatus,
  matchesQuery,
  normalizeWoStatus,
  sortWorkOrders,
  statusMatchesFilter,
  woStatusToLifecycle,
} from "../status";
import { API_ACTOR, ensureVocab, mergeAndValidateCustom, tenantOf } from "./_shared";
import { getProjectTx, updateAccessCodesTx } from "./projects";
import { pendingItemNamesTx } from "./items";
import { addVisitTx, deleteCalendarEventsTx, updateVisitTx } from "./visits";
import { loadBoardTx, loadWorkOrderTx, resolveWorkOrderId } from "./wo-read";

export const ACTION_TASK_NAME = "Work Order Tasks";
export const BILLING_TASK_NAME = "Billing";

/**
 * Thrown when a WO can't be moved to billing/completed because it still has
 * requested items that aren't resolved (router → 409). Shared with the Zoho path
 * (service.ts re-exports it).
 */
export class CompletionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionGateError";
  }
}

const PRIORITIES = ["none", "low", "medium", "high"];
function normalizePriority(p: string | null | undefined): string | null {
  const v = String(p ?? "").trim().toLowerCase();
  return PRIORITIES.includes(v) ? v : null;
}

function billingStatusFromBoolean(billable: boolean | undefined): string {
  return billable === false ? "Non-Billable" : DEFAULT_BILLING_STATUS;
}

function billingStatusOf(input: { billingStatus?: string; billable?: boolean }): string | undefined {
  if (input.billingStatus !== undefined) {
    return (BILLING_STATUSES as readonly string[]).includes(input.billingStatus) ? input.billingStatus : DEFAULT_BILLING_STATUS;
  }
  if (input.billable !== undefined) return billingStatusFromBoolean(input.billable);
  return undefined;
}

//------------------------------------------------------------------------------
// Gate + coupling helpers
//------------------------------------------------------------------------------

/** Completion gate: any non-terminal item on the WO → 409 (same message as the Zoho path). */
export async function assertItemsResolvedTx(tx: Tx, workOrderId: string): Promise<void> {
  const pending = await pendingItemNamesTx(tx, workOrderId);
  if (pending.length) {
    const names = pending.map((n) => `"${n}"`).join(", ");
    throw new CompletionGateError(
      `Cannot complete: ${pending.length} requested part(s) still pending — not yet received or marked not needed — ${names}.`
    );
  }
}

async function setTaskStatusRowTx(tx: Tx, taskId: string, status: string): Promise<void> {
  await tx`
    update public.wo_tasks set
      task_status  = ${status},
      completed_at = case when ${status === TASK_STATUS_COMPLETED} then coalesce(completed_at, now()) else null end
    where tenant_id = public.app_tenant_id() and id = ${taskId}`;
}

/** Task states follow the WO lifecycle: action → both Pending; billing → work Completed, billing Pending; completed → both Completed. */
async function coupleTasksTx(tx: Tx, wo: WorkOrder, lifecycle: WorkOrderStatus): Promise<void> {
  const work = wo.tasks.find((t) => t.kind === "work");
  const billing = wo.tasks.find((t) => t.kind === "billing");
  const workStatus = lifecycle === "action" ? TASK_STATUS_PENDING : TASK_STATUS_COMPLETED;
  const billingStatus = lifecycle === "completed" ? TASK_STATUS_COMPLETED : TASK_STATUS_PENDING;
  if (work) await setTaskStatusRowTx(tx, work.id, workStatus);
  if (billing) await setTaskStatusRowTx(tx, billing.id, billingStatus);
}

/** Write wo_status (+ closed_at / task_list_completed for Closed). Legacy spellings normalized; vocab auto-created. */
async function writeWoStatusTx(tx: Tx, workOrderId: string, label: string): Promise<string> {
  const n = normalizeWoStatus(label) || "Not Scheduled";
  await ensureVocab(tx, "wo_status", n);
  await tx`
    update public.work_orders set
      wo_status           = ${n},
      closed_at           = case when ${n === "Closed"} then coalesce(closed_at, now()) else null end,
      task_list_completed = ${n === "Closed"}
    where tenant_id = public.app_tenant_id() and id = ${workOrderId}`;
  return n;
}

/** The auto scheduling label for a WO's visits right now (Not Scheduled / Scheduled / Needs Reschedule). */
function schedulingLabel(wo: WorkOrder): string {
  const ss: ScheduleStatus = deriveScheduleStatus(wo.visits, "action");
  return CYCLE_STATUS_LABEL[ss];
}

//------------------------------------------------------------------------------
// CREATE
//------------------------------------------------------------------------------

export async function createWorkOrderTx(tx: Tx, env: Env, input: CreateWorkOrderInput, opts: { actor?: string } = {}): Promise<WorkOrder> {
  const project = await getProjectTx(tx, input.projectId);
  if (!project) throw new Error(`Project ${input.projectId} not found; cannot create a work order.`);
  if (!project.public_key) throw new Error(`Project ${input.projectId} has no key; cannot mint a WO number.`);

  const billingStatus = billingStatusOf(input) ?? DEFAULT_BILLING_STATUS;
  const priority = normalizePriority(input.priority);
  const woType = (input.woType ?? "").trim();
  if (woType) await ensureVocab(tx, "wo_type", woType);
  const custom = await mergeAndValidateCustom(tx, "work_orders", {}, input.custom);

  // Mint INSIDE this transaction: a failed insert never burns a number (keys.ts).
  const minted = await mintPublicKey(tx, "work_order", project.public_key);

  const rows = await tx<{ id: string }[]>`
    insert into public.work_orders
      (tenant_id, public_key, project_id, wo_year, wo_seq, subject, notes, priority, wo_status, billing_status, wo_type,
       company_cam_url, provision_url, custom)
    values
      (public.app_tenant_id(), ${minted.full}, ${project.id}, ${minted.year}, ${minted.seq}, ${input.subject.trim()},
       ${input.notes?.trim() || null}, ${priority}, 'Not Scheduled', ${billingStatus}, ${woType},
       ${input.companyCamUrl?.trim() || null}, ${input.provision?.trim() ?? ""}, ${tx.json(custom as never)})
    returning id`;
  const woId = rows[0].id;

  const work = await tx<{ id: string }[]>`
    insert into public.wo_tasks (tenant_id, work_order_id, kind, name, task_status, position)
    values (public.app_tenant_id(), ${woId}, 'work', ${ACTION_TASK_NAME}, ${TASK_STATUS_PENDING}, 0) returning id`;
  await tx`
    insert into public.wo_tasks (tenant_id, work_order_id, kind, name, task_status, position)
    values (public.app_tenant_id(), ${woId}, 'billing', ${BILLING_TASK_NAME}, ${TASK_STATUS_PENDING}, 1)`;
  const steps = (input.steps ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  for (let i = 0; i < steps.length; i++) {
    await tx`
      insert into public.wo_tasks (tenant_id, work_order_id, kind, parent_task_id, name, task_status, position)
      values (public.app_tenant_id(), ${woId}, 'step', ${work[0].id}, ${steps[i]}, ${TASK_STATUS_PENDING}, ${i})`;
  }

  // Access-code overrides → the PROJECT (single source of truth).
  if (input.accessCodes) await updateAccessCodesTx(tx, project.id, input.accessCodes, opts);

  await appendEvent(tx, {
    entity: "work_order",
    entityId: woId,
    eventType: "work_order.created",
    payload: {
      publicKey: minted.full,
      projectId: project.id,
      subject: input.subject.trim(),
      priority,
      billingStatus,
      woType,
      steps,
      custom,
    },
    actor: opts.actor ?? API_ACTOR,
  });

  // Optional FIRST visit. Only when a real start AND end are supplied. A calendar
  // failure must not fail the create: reported as scheduleError, WO stays unscheduled.
  let scheduleError: string | null = null;
  if (input.schedule && input.schedule.start && input.schedule.end) {
    const wo = (await loadWorkOrderTx(tx, env, woId))!;
    const r = await addVisitTx(
      tx,
      env,
      wo,
      {
        start: input.schedule.start,
        end: input.schedule.end,
        attendees: input.schedule.attendees ?? [],
        calendarId: input.schedule.calendarId,
        pending: input.schedule.pending === true,
        notifyConfirmer: input.schedule.notifyConfirmer === true,
        remote: input.schedule.remote === true,
      },
      { ...opts, tolerateCalendarFailure: true }
    );
    scheduleError = r.calendarError;
  }

  const out = (await loadWorkOrderTx(tx, env, woId))!;
  out.scheduleError = scheduleError;
  return out;
}

//------------------------------------------------------------------------------
// UPDATE (PATCH /work-orders/:id)
//------------------------------------------------------------------------------

export async function updateWorkOrderTx(
  tx: Tx,
  env: Env,
  woWireId: string,
  patch: UpdateWorkOrderInput,
  opts: { actor?: string } = {}
): Promise<WorkOrder | null> {
  const id = await resolveWorkOrderId(tx, woWireId);
  const existing = id ? await loadWorkOrderTx(tx, env, id) : null;
  if (!existing || !id) return null;

  // Scalars first (one UPDATE, only the supplied keys change).
  const current = await tx<{ custom: unknown }[]>`
    select custom from public.work_orders where tenant_id = public.app_tenant_id() and id = ${id}`;
  const custom = patch.custom !== undefined ? await mergeAndValidateCustom(tx, "work_orders", current[0].custom as Record<string, unknown>, patch.custom) : null;
  const billingPatch = billingStatusOf(patch);
  const woType = patch.woType !== undefined ? (patch.woType ?? "").trim() : null;
  if (woType) await ensureVocab(tx, "wo_type", woType);
  await tx`
    update public.work_orders set
      subject         = coalesce(${typeof patch.subject === "string" && patch.subject.trim() ? patch.subject.trim() : null}, subject),
      notes           = case when ${patch.notes !== undefined} then ${patch.notes ?? null} else notes end,
      priority        = case when ${patch.priority !== undefined} then ${normalizePriority(patch.priority)} else priority end,
      billing_status  = coalesce(${billingPatch ?? null}, billing_status),
      wo_type         = case when ${patch.woType !== undefined} then ${woType ?? ""} else wo_type end,
      company_cam_url = case when ${patch.companyCamUrl !== undefined} then ${patch.companyCamUrl?.trim() || null} else company_cam_url end,
      provision_url   = case when ${patch.provision !== undefined} then ${patch.provision?.trim() ?? ""} else provision_url end,
      custom          = coalesce(${custom ? tx.json(custom as never) : null}::jsonb, custom)
    where tenant_id = public.app_tenant_id() and id = ${id}`;

  if (patch.accessCodes) await updateAccessCodesTx(tx, existing.projectId, patch.accessCodes, opts);

  // Status change — `woStatus` wins over the legacy 3-state `status`.
  let targetLifecycle: WorkOrderStatus | null = null;
  let targetLabel: string | undefined;
  if (patch.woStatus !== undefined) {
    targetLabel = normalizeWoStatus(patch.woStatus);
    targetLifecycle = woStatusToLifecycle(targetLabel);
  } else if (patch.status) {
    targetLifecycle = patch.status;
    targetLabel = patch.status === "completed" ? "Closed" : patch.status === "billing" ? "Ready for Billing" : undefined;
  }
  let reDerive = false;
  if (targetLifecycle) {
    if (targetLifecycle === "billing" || targetLifecycle === "completed") await assertItemsResolvedTx(tx, id);
    await coupleTasksTx(tx, existing, targetLifecycle);
    // A back-half label sticks; a scheduling target (or the legacy "action") re-derives from the visits below.
    if (targetLabel && isBackHalfStatus(targetLabel)) await writeWoStatusTx(tx, id, targetLabel);
    else reDerive = true;
  }

  // Schedule → the FIRST (earliest) visit: patch it, or create it when none exists.
  if (patch.schedule) {
    const first = existing.visits[0] ?? null;
    if (first) {
      await updateVisitTx(tx, env, existing, first.id, {
        start: patch.schedule.start,
        end: patch.schedule.end,
        attendees: patch.schedule.attendees,
        calendarId: patch.schedule.calendarId,
      }, opts);
    } else if (patch.schedule.start && patch.schedule.end) {
      await addVisitTx(tx, env, existing, {
        start: patch.schedule.start,
        end: patch.schedule.end,
        attendees: patch.schedule.attendees,
        calendarId: patch.schedule.calendarId,
      }, opts);
    }
  }

  // Scheduling-state WOs keep their stored auto label current with the visits (the
  // view re-derives the effective status anyway — this keeps the column honest, exactly
  // as the Zoho mirror rewrote wo_cycle_status after every change).
  if (reDerive || (patch.schedule && !isBackHalfStatus(existing.cycleStatusRaw))) {
    const refreshed = (await loadWorkOrderTx(tx, env, id))!;
    await writeWoStatusTx(tx, id, schedulingLabel(refreshed));
  }

  await appendEvent(tx, {
    entity: "work_order",
    entityId: id,
    eventType: "work_order.updated",
    payload: { patch, targetLabel: targetLabel ?? null, targetLifecycle },
    actor: opts.actor ?? API_ACTOR,
  });
  return loadWorkOrderTx(tx, env, id);
}

//------------------------------------------------------------------------------
// TASK STATUS (PATCH /work-orders/:id/tasks/:taskId)
//------------------------------------------------------------------------------

export async function setTaskStatusTx(
  tx: Tx,
  env: Env,
  woWireId: string,
  taskId: string,
  taskStatus: string,
  opts: { actor?: string } = {}
): Promise<TaskStatusResult | null> {
  const id = await resolveWorkOrderId(tx, woWireId);
  const existing = id ? await loadWorkOrderTx(tx, env, id) : null;
  if (!existing || !id || !isUuid(taskId)) return null;
  const task = await tx<{ id: string; kind: string }[]>`
    select id, kind from public.wo_tasks
    where tenant_id = public.app_tenant_id() and id = ${taskId} and work_order_id = ${id} and deleted_at is null limit 1`;
  if (!task.length) return null;
  await setTaskStatusRowTx(tx, taskId, taskStatus);

  let autoPromoted = false;
  let gateMessage: string | null = null;
  if (task[0].kind === "work") {
    const cur = normalizeWoStatus(existing.woStatus);
    if (taskStatus === TASK_STATUS_COMPLETED && isPreBillingStatus(existing.cycleStatusRaw)) {
      try {
        await assertItemsResolvedTx(tx, id);
        await writeWoStatusTx(tx, id, "Ready for Billing");
        autoPromoted = true;
      } catch (e) {
        if (e instanceof CompletionGateError) gateMessage = e.message;
        else throw e;
      }
    } else if (taskStatus === TASK_STATUS_PENDING && (cur === "Ready for Billing" || cur === "Waiting Payment")) {
      // Work reopened: back to the calendar-driven flow; Billing task Pending again.
      await writeWoStatusTx(tx, id, schedulingLabel(existing));
      const billing = existing.tasks.find((t) => t.kind === "billing");
      if (billing) await setTaskStatusRowTx(tx, billing.id, TASK_STATUS_PENDING);
    }
  }
  await appendEvent(tx, {
    entity: "wo_task",
    entityId: taskId,
    eventType: "wo_task.status_set",
    payload: { workOrderId: id, kind: task[0].kind, taskStatus, autoPromoted, gateMessage },
    actor: opts.actor ?? API_ACTOR,
  });
  const workOrder = (await loadWorkOrderTx(tx, env, id))!;
  return { workOrder, autoPromoted, gateMessage };
}

//------------------------------------------------------------------------------
// DELETE (soft)
//------------------------------------------------------------------------------

export async function deleteWorkOrderTx(tx: Tx, env: Env, woWireId: string, opts: { actor?: string } = {}): Promise<boolean> {
  const id = await resolveWorkOrderId(tx, woWireId);
  const wo = id ? await loadWorkOrderTx(tx, env, id) : null;
  if (!wo || !id) return false;
  await deleteCalendarEventsTx(tx, env, wo.visits);
  const now = new Date();
  await tx`update public.visits    set deleted_at = ${now} where tenant_id = public.app_tenant_id() and work_order_id = ${id} and deleted_at is null`;
  await tx`update public.wo_tasks  set deleted_at = ${now} where tenant_id = public.app_tenant_id() and work_order_id = ${id} and deleted_at is null`;
  await tx`update public.work_orders set deleted_at = ${now} where tenant_id = public.app_tenant_id() and id = ${id}`;
  await appendEvent(tx, {
    entity: "work_order",
    entityId: id,
    eventType: "work_order.deleted",
    payload: { publicKey: wo.workOrderNumber, visits: wo.visits.length },
    actor: opts.actor ?? API_ACTOR,
  });
  return true;
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts
//------------------------------------------------------------------------------

export async function createWorkOrder(env: Env, input: CreateWorkOrderInput): Promise<WorkOrder> {
  return withTenant(env, tenantOf(env), (tx) => createWorkOrderTx(tx, env, input));
}

export async function getWorkOrder(env: Env, woWireId: string): Promise<WorkOrder | null> {
  return withTenantRead(env, tenantOf(env), (tx) => loadWorkOrderTx(tx, env, woWireId));
}

/** The board: filter / schedule / q / sort applied with the SAME pure helpers as the Zoho path (status.ts). */
export async function listWorkOrders(
  env: Env,
  opts: { filter: WorkOrderFilter; q?: string; sort: WorkOrderSort; schedule?: ScheduleStatus }
): Promise<WorkOrder[]> {
  const all = await withTenantRead(env, tenantOf(env), (tx) => loadBoardTx(tx, env));
  const filtered = all
    .filter((wo) => statusMatchesFilter(lifecycleOfWoStatus(wo.woStatus, wo.status), opts.filter))
    .filter((wo) => !opts.schedule || wo.scheduleStatus === opts.schedule)
    .filter((wo) => matchesQuery(wo, opts.q));
  return sortWorkOrders(filtered, opts.sort);
}

export async function updateWorkOrder(env: Env, woWireId: string, patch: UpdateWorkOrderInput): Promise<WorkOrder | null> {
  return withTenant(env, tenantOf(env), (tx) => updateWorkOrderTx(tx, env, woWireId, patch));
}

export async function setTaskStatus(env: Env, woWireId: string, taskId: string, taskStatus: string): Promise<TaskStatusResult | null> {
  return withTenant(env, tenantOf(env), (tx) => setTaskStatusTx(tx, env, woWireId, taskId, taskStatus));
}

export async function deleteWorkOrder(env: Env, woWireId: string): Promise<boolean> {
  return withTenant(env, tenantOf(env), (tx) => deleteWorkOrderTx(tx, env, woWireId));
}
