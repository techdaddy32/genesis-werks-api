//==============================================================================
// service.ts — the orchestration layer that turns Zoho + Calendar primitives
// into WorkOrder records and drives create / read / update / reconcile.
//
// A "work order" maps onto a Zoho ticket:
//   task list (the ticket)  ->  Action task (+ step subtasks)  +  Billing task
// The WO's stable id is the ACTION task id. The full composite WO number lives
// in the Action task's ZOHO_WO_FIELD custom field; scheduling metadata (event id)
// lives on the Action task description (and on the calendar event's extended props).
//==============================================================================

import type {
  Env,
  WorkOrder,
  WorkOrderTask,
  CreateWorkOrderInput,
  UpdateWorkOrderInput,
  WorkOrderFilter,
  WorkOrderSort,
  WorkOrderStatus,
  ScheduleStatus,
  Schedule,
  Visit,
  AddVisitInput,
  UpdateVisitInput,
  UsedItem,
  AddUsedItemInput,
  PatchUsedItemInput,
  LogHoursInput,
  AccessCodes,
  SyncResult,
  PurchaseItem,
  RequestItemInput,
  UpdatePurchaseInput,
  DailyReportEntry,
  DailyReportDay,
  AddDailyReportEntryInput,
  Todo,
  CreateTodoInput,
  UpdateTodoInput,
  Material,
  CreateMaterialInput,
  UpdateMaterialInput,
  TaskStatusResult,
} from "./types";
import * as zoho from "./zoho";
import { ZohoThrottleError } from "./zoho";
import { cached, cacheDelete, cacheDropPrefix } from "./cache";
import * as cal from "./calendar";
import { deriveStatus, statusMatchesFilter, deriveScheduleStatus } from "./status";
import { mintWorkOrderNumber, parseWoNumber } from "./wonumber";
import { woFieldName, orderStatusFieldName, membershipFieldName, companyCamFieldName, provisionFieldName, woTypeFieldName, orderDoneStatuses, DEFAULT_ORDER_STATUS, todoStatusFieldName, DEFAULT_TODO_STATUS,
  woTaskStatusFieldName, billingStatusFieldName, woCycleStatusFieldName, TASK_STATUS_PENDING, TASK_STATUS_COMPLETED, BILLING_STATUSES, DEFAULT_BILLING_STATUS } from "./config";
import { postToCliq } from "./cliq";
import { getAdminConfig } from "./admin";
import * as hoursRepo from "./repo/hours";
import * as dailyRepo from "./repo/daily-reports";
import { findWorkOrderRef, type WoRef } from "./repo/_shared";
import { withTenantRead } from "./db";
import { tenantOf } from "./tenant";
import { buildDailyReportPdf, buildTextPdf } from "./pdf";
import { todayET, formatDateET, formatDateTimeET } from "./time";

// Task-name conventions inside a ticket task-list. The "Work Order Tasks" task holds
// the work (steps are its subtasks); the "Billing" task drives invoicing. Status is
// derived from these two by name, so this constant is the single source of truth.
const ACTION_TASK_NAME = "Work Order Tasks";
const BILLING_TASK_NAME = "Billing";
// The per-WO "Work Order Status" task (2026-09-09): a plain task in the ticket task-list whose
// ONLY job is to carry the `wo_cycle_status` pick-list — the authoritative WO status, real in
// Zoho. Tagged with the WO# (work_order_hash) so the single portal scan returns it with the
// Action/Billing pair (no fan-out). Never shown as a checklist item in the app.
export const STATUS_TASK_NAME = "Work Order Status";
// A third task per ticket holds the daily reports: each "send daily report" is
// recorded as a dated subtask under it (viewable in Zoho; the app never edits it).
const DAILY_REPORT_TASK_NAME = "Daily Report";
// Action items live under their OWN dedicated holder task (parallel to Daily Report),
// so they stay entirely separate from the WO's "Work Order Tasks" (the Action task's
// subtasks). Each action item is a subtask under this holder. New WOs use the "Action
// Items" name; pre-change WOs used "To-Dos" — both are recognized so no duplicate holder
// is ever created. (2026-08-27: reverted a brief experiment that parented them under the
// Action task, which incorrectly surfaced them in Work Order Tasks.)
const ACTION_ITEMS_TASK_NAME = "Action Items";
const TODOS_TASK_NAME = "To-Dos"; // legacy holder name (back-compat on read + ensure)
const MATERIALS_TASK_NAME = "Materials"; // S11: holder task; subtasks = actual materials
const ACTION_ITEMS_HOLDER_NAMES = [ACTION_ITEMS_TASK_NAME, TODOS_TASK_NAME];

/**
 * Thrown by updateWorkOrder when a WO can't be moved to billing/completed because
 * it still has requested parts that aren't resolved. Distinguishable so index.ts
 * maps it to HTTP 409 (conflict) with the user-facing message. See the completion
 * gate in updateWorkOrder + assertRequestedPartsResolved.
 */
export class CompletionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionGateError";
  }
}

/**
 * Build the "open this work order" deep link that goes into calendar events.
 * Uses APP_WO_URL_TEMPLATE ({id} = WO id / actionTaskId, {wo} = full WO number)
 * if set, else defaults to `<first APP_ORIGIN>/work-orders/{id}`.
 */
function woDetailLink(env: Env, id: string, woNumber: string): string {
  const firstOrigin = (env.APP_ORIGIN || "").split(",")[0].trim();
  const tmpl =
    env.APP_WO_URL_TEMPLATE && env.APP_WO_URL_TEMPLATE.trim()
      ? env.APP_WO_URL_TEMPLATE.trim()
      : `${firstOrigin}/work-orders/{id}`;
  return tmpl.replace(/\{id\}/g, encodeURIComponent(id)).replace(/\{wo\}/g, encodeURIComponent(woNumber));
}

// Pick-list display values for the wo_schedule_status field (must match Zoho's options
// EXACTLY). Updated 2026-08-23 to the redesigned WO-status labels Craig created:
// "Not Scheduled" (was "Unscheduled") and "Needs Rescheduled" (was "Needs Reschedule").
// The back-half statuses (On Hold / Ready for Billing / Waiting Payment / Completed) are
// added when the 7-state WO-status model lands; these three are the auto-derived ones.
// LEGACY field (`wo_schedule_status` on the Action task) — its pick-list spells the third
// state "Needs Rescheduled". Still mirrored (scheduling labels only) for Zoho dashboards.
const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  unscheduled: "Not Scheduled",
  scheduled: "Scheduled",
  needs_reschedule: "Needs Rescheduled",
};
// The `wo_cycle_status` pick-list (per Craig 2026-09-09) spells it "Needs Reschedule". This is
// the app-facing label set from now on.
const CYCLE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  unscheduled: "Not Scheduled",
  scheduled: "Scheduled",
  needs_reschedule: "Needs Reschedule",
};

// The WO status model (2026-09-09, stored in Zoho as `wo_cycle_status` on the "Work Order
// Status" task). The first three are AUTO (derived from the calendar); the back half is
// MANUAL + sticky. "Closed" is the single terminal state — the legacy "Completed" migrates
// to it and is no longer offered (the pick-list still lists it; we read it as Closed).
const WO_STATUS_SCHEDULING = ["Not Scheduled", "Scheduled", "Needs Reschedule"] as const;
const WO_STATUS_BACK_HALF = ["On Hold", "Active Monitoring", "Ready for Billing", "Waiting Payment", "Closed"] as const;
export const WO_STATUSES = [...WO_STATUS_SCHEDULING, ...WO_STATUS_BACK_HALF] as const;
/** Statuses that a client may SEND (legacy spellings are normalized by normalizeWoStatus). */
export const WO_STATUS_INPUTS = [...WO_STATUSES, "Completed", "Needs Rescheduled"] as const;
/** Pre-billing statuses: the ones the all-tasks-complete rule auto-advances from. */
const WO_STATUS_PRE_BILLING = [...WO_STATUS_SCHEDULING, "On Hold", "Active Monitoring"] as const;

/** Normalize legacy / alternate spellings to the canonical wo_cycle_status label. */
export function normalizeWoStatus(s: string): string {
  const t = (s ?? "").trim();
  if (t === "Completed") return "Closed";
  if (t === "Needs Rescheduled") return "Needs Reschedule";
  return t;
}

/** Map a woStatus to the legacy lifecycle (which tasks are open/closed). */
function woStatusToLifecycle(s: string): WorkOrderStatus {
  const n = normalizeWoStatus(s);
  if (n === "Closed") return "completed";
  if (n === "Ready for Billing" || n === "Waiting Payment") return "billing";
  return "action"; // the three scheduling states + On Hold / Active Monitoring are all "active"
}

/** Lifecycle bucket for a woStatus label (board filters); unknown labels fall back to the derived lifecycle. */
function lifecycleOfWoStatus(woStatus: string, fallback: WorkOrderStatus): WorkOrderStatus {
  const n = normalizeWoStatus(woStatus);
  return (WO_STATUSES as readonly string[]).includes(n) ? woStatusToLifecycle(n) : fallback;
}

/** Read a task pick-list value (portal `raw` first, then the normalized customFields map). */
function taskField(task: zoho.ZohoTask | null | undefined, field: string): string {
  const raw = (task?.raw?.[field] ?? task?.customFields?.[field]) as unknown;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The effective woStatus, read WITHOUT extra API calls:
 *   1. `wo_cycle_status` on the "Work Order Status" task — a manual (sticky) value wins;
 *      a scheduling value there is re-derived from the calendar so the auto states stay live;
 *   2. PRE-MIGRATION fallback: a manual value in the legacy `wo_schedule_status` on the Action task;
 *   3. lifecycle (both tasks closed → Closed; Action closed → Ready for Billing);
 *   4. the auto scheduling label.
 */
function woStatusFromTasks(
  env: Env,
  action: zoho.ZohoTask,
  statusTask: zoho.ZohoTask | null,
  lifecycle: WorkOrderStatus,
  scheduleStatus: ScheduleStatus
): string {
  const cycle = normalizeWoStatus(taskField(statusTask, woCycleStatusFieldName(env)));
  if ((WO_STATUS_BACK_HALF as readonly string[]).includes(cycle)) return cycle;
  if (!statusTask) {
    const legacy = normalizeWoStatus(taskField(action, env.ZOHO_SCHEDSTATUS_FIELD || "wo_schedule_status"));
    if ((WO_STATUS_BACK_HALF as readonly string[]).includes(legacy)) return legacy;
  }
  if (lifecycle === "completed") return "Closed";
  if (lifecycle === "billing") return "Ready for Billing";
  return CYCLE_STATUS_LABEL[scheduleStatus];
}

/** A task's wo_task_status (Pending | Completed), falling back to its native open/closed flag. */
function taskStatusOf(env: Env, task: zoho.ZohoTask | null | undefined): string {
  if (!task) return TASK_STATUS_PENDING;
  const v = taskField(task, woTaskStatusFieldName(env));
  if (v === TASK_STATUS_PENDING || v === TASK_STATUS_COMPLETED) return v;
  return task.isCompleted ? TASK_STATUS_COMPLETED : TASK_STATUS_PENDING;
}

/** The Billing task's billing_status (Billable | Non-Billable | Internal); default Billable. */
function billingStatusOf(env: Env, billing: zoho.ZohoTask | null | undefined): string {
  const v = taskField(billing, billingStatusFieldName(env));
  return (BILLING_STATUSES as readonly string[]).includes(v) ? v : DEFAULT_BILLING_STATUS;
}

/** Legacy boolean → billing_status label. */
function billingStatusFromBoolean(billable: boolean | undefined): string {
  return billable === false ? "Non-Billable" : DEFAULT_BILLING_STATUS;
}

/**
 * Write a task's wo_task_status AND its native open/closed status in ONE PATCH, so Zoho's own
 * views (and the legacy lifecycle derivation) stay consistent with the pick-list.
 */
async function writeTaskStatus(env: Env, projectId: string, taskId: string, status: string): Promise<void> {
  const completed = status === TASK_STATUS_COMPLETED;
  const statusId = completed ? env.ZOHO_STATUS_CLOSED_ID : env.ZOHO_STATUS_OPEN_ID;
  const body: Record<string, unknown> = { [woTaskStatusFieldName(env)]: status };
  if (statusId) body.status = { id: statusId }; else body.is_completed = completed;
  try {
    await zoho.patchTask(env, projectId, taskId, body);
  } catch (e) {
    // Zoho refuses field edits on a CLOSED task ("cannot update a closed task", live
    // 2026-09-09) — reopen it first, then apply the field + the intended status together.
    if (e instanceof ZohoThrottleError || !isClosedTaskError(e)) throw e;
    const reopen: Record<string, unknown> = env.ZOHO_STATUS_OPEN_ID ? { status: { id: env.ZOHO_STATUS_OPEN_ID } } : { is_completed: false };
    await zoho.patchTask(env, projectId, taskId, reopen);
    await zoho.patchTask(env, projectId, taskId, body);
  }
}
function isClosedTaskError(e: unknown): boolean {
  return /cannot update a closed task/i.test(String((e as Error)?.message ?? e));
}

/**
 * Best-effort mirror of the schedule into Zoho task custom fields (wo_schedule /
 * wo_date_time / wo_schedule_status) so scheduling is filterable/dashboardable IN
 * Zoho. Never throws — the authoritative visit store is the description trailer, so
 * a field-write hiccup (e.g. date format) must not break create or visit ops.
 */
async function mirrorScheduleFields(
  env: Env,
  projectId: string,
  taskId: string,
  visits: Visit[],
  lifecycle: WorkOrderStatus,
  currentWoStatus?: string,
  statusTaskId?: string | null
): Promise<void> {
  const dataField = env.ZOHO_VISITS_FIELD || "wo_schedule";
  const dateField = env.ZOHO_NEXTVISIT_FIELD || "wo_date_time";
  const statusField = env.ZOHO_SCHEDSTATUS_FIELD || "wo_schedule_status";
  const sorted = sortVisits(visits);

  // The AUTHORITATIVE status (2026-09-09): `wo_cycle_status` on the "Work Order Status" task.
  // A manual back-half value is sticky; otherwise the calendar-derived scheduling label.
  // Written first, on its own, so a legacy-field hiccup below can never mask it.
  const cycleLabel =
    currentWoStatus && (WO_STATUS_BACK_HALF as readonly string[]).includes(normalizeWoStatus(currentWoStatus))
      ? normalizeWoStatus(currentWoStatus)
      : CYCLE_STATUS_LABEL[deriveScheduleStatus(visits, lifecycle)];
  if (statusTaskId) {
    try {
      await zoho.setTaskFields(env, projectId, statusTaskId, { [woCycleStatusFieldName(env)]: cycleLabel });
    } catch (e) {
      if (e instanceof ZohoThrottleError) throw e;
      console.warn("mirrorScheduleFields (wo_cycle_status) failed, non-fatal:", e);
    }
  }

  // Next visit = earliest upcoming start, else the latest known start.
  const now = Date.now();
  const dated = sorted
    .filter((v) => v.start)
    .map((v) => ({ v, t: Date.parse(v.start as string) }))
    .filter((x) => !Number.isNaN(x.t));
  const upcoming = dated.filter((x) => x.t >= now).sort((a, b) => a.t - b.t)[0];
  const latest = [...dated].sort((a, b) => b.t - a.t)[0];
  const nextStart = (upcoming ?? latest)?.v.start ?? "";

  // LEGACY `wo_schedule_status` on the Action task: once a Status task exists it carries ONLY
  // the calendar-derived scheduling label (its pick-list has no "Closed"); pre-migration WOs
  // (no Status task yet) keep the old behaviour so a manual value still sticks somewhere.
  const manual = currentWoStatus && (WO_STATUS_BACK_HALF as readonly string[]).includes(normalizeWoStatus(currentWoStatus));
  const statusLabel =
    manual && !statusTaskId
      ? (normalizeWoStatus(currentWoStatus as string) === "Closed" ? "Completed" : normalizeWoStatus(currentWoStatus as string))
      : SCHEDULE_STATUS_LABEL[deriveScheduleStatus(visits, lifecycle)];

  // Strings first (safe), then the date separately so a date-format issue can't
  // block the status/data writes.
  try {
    // wo_schedule now carries a tiny "pending" marker (else "") so the LIGHT board/calendar
    // path (woFromPortalTask) can show a tentative indicator without fetching each subtask.
    // (This also keeps clearing the legacy base64 blob when there's nothing pending.)
    // wo_schedule carries a compact JSON marker so the LIGHT board/calendar path can show
    // tentative (p), remote (r), and the next visit's assigned techs (t) WITHOUT a per-row
    // subtask fetch — this is what makes the Schedule-tab technician filter actually work.
    const anyPending = visits.some((v) => v.confirmed === false);
    const anyRemote = visits.some((v) => v.remote === true);
    const nextVisit = (upcoming ?? latest)?.v;
    const nextTechs = (nextVisit?.attendees ?? []).filter(Boolean);
    const markerObj: { p?: 1; r?: 1; t?: string[] } = {};
    if (anyPending) markerObj.p = 1;
    if (anyRemote) markerObj.r = 1;
    if (nextTechs.length) markerObj.t = nextTechs;
    const marker = Object.keys(markerObj).length ? JSON.stringify(markerObj) : "";
    // One PATCH for all three (was two — the date used to go separately so a date-format
    // problem couldn't block the strings). Keep that safety as a RETRY path instead of paying
    // the second write every time.
    try {
      await zoho.setTaskFields(env, projectId, taskId, {
        [dataField]: marker,
        [statusField]: statusLabel,
        [dateField]: nextStart,
      });
    } catch (e) {
      if (e instanceof ZohoThrottleError) throw e;
      console.warn("mirrorScheduleFields (combined) failed — retrying strings and date separately:", e);
      await zoho.setTaskFields(env, projectId, taskId, { [dataField]: marker, [statusField]: statusLabel });
      try {
        await zoho.setTaskFields(env, projectId, taskId, { [dateField]: nextStart });
      } catch (e2) {
        console.warn("mirrorScheduleFields (date) failed, non-fatal:", e2);
      }
    }
  } catch (e) {
    if (e instanceof ZohoThrottleError) throw e; // never hide a rate limit as "mirrored"
    console.warn("mirrorScheduleFields (status/data) failed, non-fatal:", e);
  }
}

// We stash the calendar event id (and calendar id) in the Action description as a
// machine-readable trailer so the WO record is self-describing without extra storage.
// (LEGACY single-event trailer — still READ for migration; new writes use the
// visits trailer below.)
const EVENT_META_RE = /<!--\s*fhi-cal:(\{.*?\})\s*-->/s;

interface EventMeta {
  calendarId: string;
  eventId: string;
}

// A work order can have SEVERAL visits, serialized into the Action description
// alongside a human-readable "Scheduled Visits" section.
//
// STORAGE FORMAT (v1): a PLAIN-TEXT base64url token `fhi-visits-v1:<b64url>`.
// We deliberately do NOT use an HTML comment: Zoho Projects sanitizes the task
// description on save and STRIPS `<!-- ... -->` comments, which silently dropped
// every visit (bug 2026-08-20). base64url is [A-Za-z0-9_-] only, so it carries no
// HTML-special characters and survives rich-text sanitization intact.
const VISITS_TOKEN_RE = /fhi-visits-v1:([A-Za-z0-9_-]+)/;
// LEGACY html-comment trailer — still READ for back-compat, never written anymore.
const VISITS_META_RE = /<!--\s*fhi-visits:(\[.*?\])\s*-->/s;
// Matches the human-readable section from its header to the end of the string.
// writeVisits always appends the section LAST (after stripping trailers), so a
// greedy match to end-of-string is safe; the machine trailer is removed separately.
const VISITS_SECTION_RE = /\n*── Scheduled Visits ──[\s\S]*$/;

//------------------------------------------------------------------------------
// CREATE
//------------------------------------------------------------------------------
export async function createWorkOrder(env: Env, input: CreateWorkOrderInput): Promise<WorkOrder> {
  const project = await zoho.getProject(env, input.projectId);
  if (!project.key) {
    throw new Error(`Project ${input.projectId} has no key; cannot mint a WO number.`);
  }

  // NOTE ON NUMBER ASSIGNMENT: we create the ticket task-list + tasks FIRST, then
  // mint the WO number. This guarantees a sequence number is only ever consumed once
  // the work order is really being saved — if any create step fails, no number is
  // burned. (Nothing here runs unless the app POSTs a save; opening/cancelling the
  // form never reaches this code, so cancel creates nothing.)

  // 1) Create the ticket task-list.
  const taskList = await zoho.createTaskList(env, project.id, input.subject);

  // 2) Create the Action task with initial notes (description). Carries wo_task_status=Pending.
  const taskStatusField = woTaskStatusFieldName(env);
  const billingStatus = input.billingStatus && (BILLING_STATUSES as readonly string[]).includes(input.billingStatus)
    ? input.billingStatus
    : billingStatusFromBoolean(input.billable);
  const action = await zoho.createTask(env, project.id, {
    name: ACTION_TASK_NAME,
    taskListId: taskList.id,
    description: input.notes ?? "",
    priority: input.priority,
    customFields: { [taskStatusField]: TASK_STATUS_PENDING },
  });

  // 3) Create the Billing task (wo_task_status=Pending + billing_status from the form).
  const billing = await zoho.createTask(env, project.id, {
    name: BILLING_TASK_NAME,
    taskListId: taskList.id,
    customFields: { [taskStatusField]: TASK_STATUS_PENDING, [billingStatusFieldName(env)]: billingStatus },
  });

  // 3a) Create the "Work Order Status" task — the WO status lives here (wo_cycle_status),
  // initial state Not Scheduled. Tagged with the WO# below (step 6) like Billing.
  const statusTask = await zoho.createTask(env, project.id, {
    name: STATUS_TASK_NAME,
    taskListId: taskList.id,
    customFields: { [woCycleStatusFieldName(env)]: "Not Scheduled" },
  });

  // 3b) Create the Daily Report task (holds dated daily-report subtasks). No
  // priority. The app never edits it directly; it's viewable in Zoho.
  const dailyReport = await zoho.createTask(env, project.id, {
    name: DAILY_REPORT_TASK_NAME,
    taskListId: taskList.id,
  });

  // 3c) Create the "Action Items" holder task (holds the WO's action-item subtasks). No
  // priority. Parallel to the Daily Report task; each action item is a subtask under it,
  // keeping them out of the Action task's "Work Order Tasks" subtasks.
  const actionItems = await zoho.createTask(env, project.id, {
    name: ACTION_ITEMS_TASK_NAME,
    taskListId: taskList.id,
  });

  // 4) Mint the composite number NOW (tasks exist → this save is real).
  const minted = await mintWorkOrderNumber(env, project.key);

  // 5) Create step subtasks under Action.
  if (input.steps?.length) {
    await zoho.createSteps(env, project.id, taskList.id, action.id, input.steps, { [taskStatusField]: TASK_STATUS_PENDING });
  }

  // 6) Persist the full WO number into the task custom field (refuses if unconfigured).
  await zoho.setWorkOrderField(env, project.id, action.id, minted.full);
  // ALSO tag the Billing task with the same WO#. This is what makes the single
  // portal-wide list query (filter: work_order_hash contains "-WO-") return BOTH
  // the Action and Billing tasks for each ticket, so status can be derived without
  // any extra per-project calls. (No back-compat concern: there are zero existing WOs.)
  await zoho.setWorkOrderField(env, project.id, billing.id, minted.full);
  // ...and the Status task, so the board scan carries wo_cycle_status for free.
  await zoho.setWorkOrderField(env, project.id, statusTask.id, minted.full);

  // 6b) Rename the ticket task-list so its Zoho title carries the SHORT WO portion:
  // `<short WO#> - <entered subject>` (e.g. "WO-2026-0017 - Replace pool light"). Zoho
  // already surfaces the FHI-<projnum> project number, so the title drops the leading
  // "<project.key>-" and shows only the WO portion. BEST-EFFORT: the WO already exists
  // at this point, so a rename hiccup must NOT fail the create — we warn and continue.
  // The app-facing `subject` stays the clean entered text (stripWoPrefix strips this
  // prefix on read, tolerating the old full-number prefix for pre-change WOs too).
  const shortWo = minted.full.startsWith(project.key + "-")
    ? minted.full.slice(project.key.length + 1)
    : minted.full;
  try {
    await zoho.updateTaskList(env, project.id, taskList.id, `${shortWo} - ${input.subject}`);
  } catch (e) {
    console.warn(`WO ${minted.full} created; task-list rename failed (non-fatal):`, e);
  }

  // 6c) Optional CompanyCam URL -> Action task custom field. NO-OP unless the field is
  // configured AND a url was supplied. BEST-EFFORT: the WO already exists, so a field
  // write hiccup must NOT fail the create — we warn and continue.
  const companyCamField = companyCamFieldName(env);
  if (companyCamField && input.companyCamUrl !== undefined) {
    try {
      await zoho.setTaskFields(env, project.id, action.id, { [companyCamField]: input.companyCamUrl });
    } catch (e) {
      console.warn(`WO ${minted.full} created; CompanyCam URL write failed (non-fatal):`, e);
    }
  }

  // 6d) Optional provision-ticket URL -> Action task `provision` custom field. Written
  // only when supplied. TOLERANT: the field may not exist in Zoho yet (admin creates it
  // separately), so we wrap the write — a missing-field / any write hiccup is caught,
  // logged, and non-fatal, so the WO create (and the UI) keep working until it exists.
  if (input.provision !== undefined) {
    try {
      await zoho.setTaskFields(env, project.id, action.id, { [provisionFieldName(env)]: input.provision });
    } catch (e) {
      console.warn(`WO ${minted.full} created; provision URL write failed (non-fatal — field may not exist yet):`, e);
    }
  }
  if (input.woType !== undefined && input.woType) {
    try {
      await zoho.setTaskFields(env, project.id, action.id, { [woTypeFieldName(env)]: input.woType });
    } catch (e) {
      console.warn(`WO ${minted.full} created; wo_type write failed (non-fatal — field/option may not exist yet):`, e);
    }
  }

  // 7) Optional access-code overrides -> write back to the PROJECT.
  if (input.accessCodes) {
    await zoho.updateAccessCodes(env, project.id, input.accessCodes);
    await invalidateProjectCaches(env, project.id);
  }
  const accessCodes = await zoho.getAccessCodes(env, project.id);

  // 8) Optional FIRST visit (its own calendar event, techs as guests).
  // Only create an event when a real start AND end are supplied. An empty/partial
  // schedule object (the UI may send one) means "no date yet" — the WO is created
  // unscheduled and visits can be added later via POST /work-orders/:id/visits.
  // The visit is stored in the VISITS trailer (not the legacy single-event meta),
  // so create and the visits endpoints share one storage path.
  let visits: Visit[] = [];
  let scheduleError: string | null = null;
  if (input.schedule && input.schedule.start && input.schedule.end) {
    // IMPORTANT: scheduling is OPTIONAL and secondary. The Zoho work order already
    // exists by this point, so a calendar failure (e.g. Google not connected /
    // token expired) must NOT fail the whole create and leave an orphan WO. We
    // catch it, keep the WO unscheduled, and report scheduleError so the UI can
    // say "created, but couldn't schedule — reconnect Google / add the visit later."
    try {
      const pending = input.schedule.pending === true;
      const remote = input.schedule.remote === true;
      const calendarId = input.schedule.calendarId ?? env.DEFAULT_CALENDAR_ID;
      const attendees = input.schedule.attendees ?? [];
      const body = cal.buildEventBody({
        fullWoNumber: minted.full,
        client: clientOf(project.name),
        subject: input.subject,
        siteAddress: projectSiteAddress(project),
        notes: input.notes ?? null,
        accessCodesText: formatAccessCodes(accessCodes),
        woLink: woDetailLink(env, action.id, minted.full),
        start: input.schedule.start,
        end: input.schedule.end,
        attendees,
        tentative: pending,
      });
      const ev = await cal.insertEvent(env, calendarId, body);
      // Tentative first visit: only notify the scheduling confirmer + create their confirm
      // to-do when explicitly asked (notifyConfirmer, default OFF). Otherwise the visit is
      // still TENTATIVE (in-app confirm) but nobody is pinged.
      let confirmTodoId: string | null = null;
      const notifyConfirmer = input.schedule.notifyConfirmer === true;
      if (pending && notifyConfirmer) {
        const confirmer = await schedulingConfirmerName(env);
        const whenLabel = formatDateTimeET(input.schedule.start);
        const shortWo = shortWo_(minted.full);
        try {
          await postToCliq(
            env.CLIQ_SCHEDULING_WEBHOOK,
            `TENTATIVE appointment needs confirmation\n@${confirmer}\n${clientOf(project.name)} \u00b7 ${shortWo} \u2014 ${input.subject}\nWhen: ${whenLabel} (ET)\nConfirm it in the app to post it officially.`
          );
        } catch (e) { console.warn("createWorkOrder: Cliq scheduling notify failed (non-fatal):", e); }
        try {
          const todo = await addTodo(env, action.id, {
            title: `Confirm appointment \u2014 ${whenLabel}`,
            status: DEFAULT_TODO_STATUS,
            priority: "high",
            assignee: confirmer,
            notes: `Tentative visit for ${clientOf(project.name)} (${shortWo}). Confirm in the app to remove the TENTATIVE marker and post it officially.`,
          });
          confirmTodoId = todo?.id ?? null;
        } catch (e) { console.warn("createWorkOrder: confirm-todo create failed (non-fatal):", e); }
      }
      const draft = {
        start: input.schedule.start,
        end: input.schedule.end,
        attendees,
        label: null,
        calendarId,
        eventId: ev.id,
        htmlLink: ev.htmlLink ?? null,
        confirmed: !pending,
        confirmTodoId,
        remote,
      };
      // Persist the visit as a legible subtask under the WO's "Schedule" task.
      const visitId = await createVisitSubtask(env, project.id, taskList.id, minted.full, draft);
      visits = [{ id: visitId, ...draft }];
    } catch (e) {
      scheduleError = e instanceof Error ? e.message : String(e);
      console.warn(`WO ${minted.full} created; calendar event failed (unscheduled):`, scheduleError);
      visits = [];
    }
  }

  // Mirror the schedule into the Zoho fields (best-effort). Lifecycle is "action" at
  // create (Action task just opened).
  await mirrorScheduleFields(env, project.id, action.id, visits, "action", undefined, statusTask.id);

  const wo = assembleWorkOrder(env, project, taskList.id, taskList.isCompleted, action, billing, accessCodes, visits, minted.full, dailyReport.id, actionItems.id, statusTask);
  // The in-memory tasks predate the field writes — reflect what we just wrote.
  wo.billingStatus = billingStatus;
  wo.billable = billingStatus === "Billable";
  wo.woStatus = CYCLE_STATUS_LABEL[deriveScheduleStatus(visits, "action")];
  // Keep the app-facing subject the CLEAN entered text — the Zoho task-list title now
  // carries the "<WO#> - " prefix (renamed above), but the app must not show the number twice.
  wo.subject = input.subject;
  // The in-memory `action` doesn't carry the CompanyCam value we just wrote, so reflect
  // it on the create response directly (empty string -> null).
  if (companyCamField && input.companyCamUrl !== undefined) {
    wo.companyCamUrl = input.companyCamUrl || null;
  }
  // Likewise reflect the provision URL we just wrote (the in-memory `action` predates
  // the write). Empty/cleared -> "" so the field is always a string on the response.
  if (input.provision !== undefined) {
    wo.provision = input.provision || "";
  }
  if (input.woType !== undefined) {
    wo.woType = input.woType || "";
  }
  wo.scheduleError = scheduleError;
  return wo;
}

//------------------------------------------------------------------------------
// LIST
//------------------------------------------------------------------------------
export async function listWorkOrders(
  env: Env,
  opts: { filter: WorkOrderFilter; q?: string; sort: WorkOrderSort; schedule?: ScheduleStatus }
): Promise<WorkOrder[]> {
  // ONE portal-wide query instead of scanning every project (which times out at
  // ~250 projects). Filter on the work_order_hash column: every real WO reference
  // (e.g. FHI-672-WO-2026-0001) contains "-WO-", so this returns exactly the WO
  // tasks — and because BOTH the Action and Billing tasks are tagged with the WO#
  // (see createWorkOrder), each ticket's pair comes back in the same query, so
  // status is derived with no additional per-project fan-out.
  const tasks = await listWoTaggedTasks(env);

  // Group by task-list id; each ticket = one Action + one Billing task.
  const grouped = groupTicketsFromTasks(tasks);

  const all: WorkOrder[] = [];
  for (const [taskListId, pair] of grouped) {
    if (!pair.action) continue; // skip groups with no Action task
    all.push(woFromPortalTask(env, taskListId, pair.action, pair.billing, pair.others, pair.statusTask));
  }

  // Board chips key off the Zoho-native woStatus (2026-09-09): done = Closed; billing =
  // Ready for Billing / Waiting Payment; active = everything else. Falls back to the
  // lifecycle derivation for any unrecognized label.
  const filtered = all
    .filter((wo) => statusMatchesFilter(lifecycleOfWoStatus(wo.woStatus, wo.status), opts.filter))
    // Optional schedule-status filter, applied alongside the lifecycle filter/q.
    .filter((wo) => !opts.schedule || wo.scheduleStatus === opts.schedule)
    .filter((wo) => matchesQuery(wo, opts.q));

  return sortWorkOrders(filtered, opts.sort);
}

//------------------------------------------------------------------------------
// PROJECT SEARCH (for the client picker on the New Work Order form)
//------------------------------------------------------------------------------
export interface ProjectHit {
  id: string;
  key: string | null;
  name: string;
  client: string;
  siteAddress: string | null;
  // Additive structured address parts (safe extras the app can use later). Present
  // when Zoho has them; null otherwise. Never parsed out of the project name.
  siteCity: string | null;
  siteState: string | null;
  siteZip: string | null;
  isService: boolean;
  // Support-membership level (Zoho project custom field, default support_membership_actual).
  // Null when the project has no membership set. Surfaced so the Projects dashboard can show
  // it per-row without deriving it from work orders (the light WO list carries it as null).
  membershipLevel: string | null;
}

/**
 * Search client projects by name for the picker. By default only SERVICE projects
 * (the "Client - Address - SERVICE" convention) are returned; pass includeAll to
 * include every project (e.g. Install/internal projects like "Stark Tower").
 */
export async function searchProjects(
  env: Env,
  opts: { q: string; includeAll?: boolean; refresh?: boolean }
): Promise<ProjectHit[]> {
  // Rate-limit relief (2026-09-03): the full list (q="") is what the Projects tab, the WO board
  // (membership badges) and the New-WO picker all load, and it can fan out into ~40 detail
  // back-fills. Cache the finished result (fresh 2 min, stale kept 30 min for throttle fallback);
  // setProjectMembership invalidates it. Typed searches are cached briefly too.
  const key = `proj:search:${opts.includeAll ? "all" : "svc"}:${(opts.q ?? "").trim().toLowerCase()}`;
  const r = await cached(env, key, { freshMs: opts.q ? 60_000 : 120_000, staleTtlS: 30 * 60, refresh: opts.refresh }, () =>
    searchProjectsUncached(env, opts)
  );
  return r.value;
}

/** Per-project detail back-fill cache — address + membership change rarely; 10 min. */
const PROJECT_DETAIL_FRESH_MS = 10 * 60_000;
async function getProjectDetailCached(env: Env, projectId: string): Promise<zoho.ZohoProject> {
  const r = await cached(env, `proj:detail:${projectId}`, { freshMs: PROJECT_DETAIL_FRESH_MS, staleTtlS: 30 * 60 }, () =>
    zoho.getProject(env, projectId)
  );
  return r.value;
}

/** Drop cached project lists/details after a project write (membership etc.). */
export async function invalidateProjectCaches(env: Env, projectId?: string): Promise<void> {
  cacheDropPrefix("proj:search:");
  await cacheDelete(env, "proj:search:svc:", "proj:search:all:", ...(projectId ? [`proj:detail:${projectId}`] : []));
}

async function searchProjectsUncached(
  env: Env,
  opts: { q: string; includeAll?: boolean }
): Promise<ProjectHit[]> {
  const projects = await zoho.searchProjects(env, opts.q);
  // Belt-and-suspenders: never surface the FHI-907 PURCHASING project in the client
  // picker (it won't match the "- SERVICE" suffix anyway, but excluding by id makes
  // that guarantee independent of the naming convention).
  const purchasingId = env.ZOHO_PURCHASING_PROJECT_ID;
  const kept = projects
    .filter((p) => !purchasingId || p.id !== purchasingId)
    .filter((p) => (opts.includeAll ? true : zoho.isServiceProject(env, p)));

  // Address comes from Zoho's STRUCTURED site fields (site_address/city/state/zip),
  // NOT parsed out of the project name (the "…Ave- SERVICE" format is inconsistent).
  // ROOT-CAUSE GUARD: the v3 projects LIST call may omit these fields, in which case
  // the list-normalized value is null. Back-fill from the per-project detail fetch —
  // but ONLY up to a small cap, so the fast picker search (a handful of hits) always
  // resolves while a large `all=true` scan can never fan out into a timeout.
  // Membership (custom field) is normally a TOP-LEVEL key on the v3 project (like the site
  // fields) so it comes back on the list for free. Back-fill from the per-project detail when
  // EITHER the address OR the membership is missing — but bounded by a cap so a large scan can
  // never fan out into a Worker subrequest blow-up / timeout.
  const missing = kept.filter((p) => !p.siteAddress || !membershipFromProject(env, p));
  const DETAIL_BACKFILL_CAP = 40;
  if (missing.length > 0 && missing.length <= DETAIL_BACKFILL_CAP) {
    // Bounded concurrency (was unbounded 40-wide) + per-project detail cache.
    const details: (zoho.ZohoProject | null)[] = [];
    const CONC = 8;
    for (let i = 0; i < missing.length; i += CONC) {
      const chunk = await Promise.all(
        missing.slice(i, i + CONC).map(async (p) => {
          try {
            return await getProjectDetailCached(env, p.id);
          } catch (e) {
            if (e instanceof ZohoThrottleError) throw e; // let the list cache serve stale
            console.warn(`searchProjects: detail back-fill for ${p.id} failed (non-fatal):`, e);
            return null;
          }
        })
      );
      details.push(...chunk);
    }
    const byId = new Map<string, zoho.ZohoProject>();
    for (const d of details) if (d) byId.set(d.id, d);
    for (const p of missing) {
      const d = byId.get(p.id);
      if (!d) continue;
      p.siteAddress = d.siteAddress;
      p.siteCity = d.siteCity;
      p.siteState = d.siteState;
      p.siteZip = d.siteZip;
      // carry the detail's custom fields (incl. membership) so membershipFromProject resolves
      p.customFields = d.customFields;
    }
  }

  return kept.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    client: clientOf(p.name),
    siteAddress: p.siteAddress ?? null,
    siteCity: p.siteCity ?? null,
    siteState: p.siteState ?? null,
    siteZip: p.siteZip ?? null,
    isService: zoho.isServiceProject(env, p),
    membershipLevel: membershipFromProject(env, p),
  }));
}

//------------------------------------------------------------------------------
// GET ONE  (id = Action task id; caller may not know the project, so we search)
//------------------------------------------------------------------------------
export async function getWorkOrder(
  env: Env,
  actionTaskId: string,
  opts: { allowCached?: boolean } = {}
): Promise<WorkOrder | null> {
  // Rate-limit relief (2026-09-03, pass 3): READ paths may answer both portal filters (this task
  // by id, and this WO's tagged subtasks by hash) from the cached "-WO-" scan — the same portal
  // endpoint/fields, so the rows are identical. Live fallback when the task isn't in the scan
  // (just created, or cache cold). WRITE paths keep live reads so a re-hydrate after a write
  // always reflects it (the router invalidates the scan after every successful write anyway).
  let scan: zoho.ZohoTask[] | null = null;
  let hit: zoho.ZohoTask | undefined;
  if (opts.allowCached) {
    try {
      scan = await listWoTaggedTasks(env);
      hit = scan.find((t) => t.id === actionTaskId);
    } catch (e) {
      if (e instanceof ZohoThrottleError) throw e;
      scan = null;
    }
    if (!hit) scan = null; // not in the cached scan → don't trust it for the subtasks either
  }
  if (!hit) {
    // Look the ONE task up directly by id via the portal-wide query — no project scan.
    const found = await zoho.listPortalTasksByFilter(
      env,
      JSON.stringify({
        criteria: [{ field_name: "id", criteria_condition: "is", value: [actionTaskId] }],
        pattern: "1",
      })
    );
    hit = found[0];
  }
  if (!hit || !hit.projectId || !hit.taskListId) return null;

  const projectId = hit.projectId;
  const taskListId = hit.taskListId;

  // Full-detail hydration for THIS ONE project only (a few calls, acceptable):
  // getTasksByProject to find the Billing task + the Action description (which
  // carries the event-meta trailer), getProject for the access codes, and the
  // task-list completion flag. Assembled through the existing woFromParts helper.
  const woHash = hit.workOrderHash ?? "";
  const [tasks, woTagged, project, lists] = await Promise.all([
    zoho.getTasksByProject(env, projectId),
    // Visit + item + todo subtasks are found by the proven work_order_hash portal filter,
    // NOT has_parents (which proved unreliable — the dashboard bug). Exact-match this WO's #.
    !woHash
      ? Promise.resolve([] as zoho.ZohoTask[])
      : scan
      ? Promise.resolve(scan.filter((t) => (t.workOrderHash ?? "") === woHash))
      : zoho.listPortalTasksByFilter(
          env,
          JSON.stringify({ criteria: [{ field_name: woFieldName(env), criteria_condition: "is", value: [woHash] }], pattern: "1" })
        ),
    getProjectDetailCached(env, projectId), // access codes only — cached 10 min, invalidated on write
    zoho.getTaskLists(env, projectId),
  ]);
  const action = tasks.find((t) => t.id === actionTaskId) ?? hit;
  // The portal `hit` reliably carries the WO# (workOrderHash) and the description
  // (where the visits token lives); the per-project task endpoint often omits both.
  // Backfill from hit so the detail view returns the WO number + visits.
  if (!action.workOrderHash) action.workOrderHash = hit.workOrderHash;
  if (!action.description) action.description = hit.description ?? null;
  const billing =
    tasks.find((t) => t.taskListId === taskListId && t.name === BILLING_TASK_NAME) ?? null;
  // The "Work Order Status" task (carries wo_cycle_status). Prefer the WO-tagged copy (the
  // portal shape reliably carries custom fields); null for un-migrated WOs.
  const statusTask =
    woTagged.find((t) => t.name === STATUS_TASK_NAME) ??
    tasks.find((t) => t.taskListId === taskListId && t.name === STATUS_TASK_NAME) ?? null;
  // Locate the Daily Report task by name in this ticket's task list (same way we
  // find Action/Billing). Null for WOs created before this feature — never fail.
  const dailyReport =
    tasks.find((t) => t.taskListId === taskListId && t.name === DAILY_REPORT_TASK_NAME) ?? null;
  // Locate the Action Items holder by name (accepts the legacy "To-Dos" name for pre-change
  // WOs). Null for pre-feature WOs. Vestigial (todoTaskId) — listing is token-based.
  const todoTask =
    tasks.find((t) => t.taskListId === taskListId && ACTION_ITEMS_HOLDER_NAMES.includes(t.name)) ?? null;
  const listDone = lists.find((l) => l.id === taskListId)?.isCompleted ?? false;
  const accessCodes = accessCodesFromProject(project);
  // Visits: legible "Schedule" subtasks via the work_order_hash filter (fallback to the
  // legacy trailer for un-migrated WOs).
  const visits = readVisitsForWo(env, action, woTagged);
  // Todos: this WO's to-do subtasks, derived from the already-fetched woTagged set (matched
  // by the todo token's workOrderId). No extra call, no has_parents. Active only.
  const todos = todosFromSubtasks(env, woTagged, actionTaskId, false);
  const wo = await woFromParts(env, project, taskListId, listDone, action, billing, accessCodes, dailyReport?.id ?? null, visits, todoTask?.id ?? null, todos, statusTask);

  // PROMOTE ON READ (Craig 2026-09-09): if the Work Order Tasks task reads Completed (checked
  // in the app OR directly in Zoho) while the WO is still pre-billing, auto-advance it to
  // Ready for Billing — regardless of billing status. Runs the items completion gate; when
  // the gate blocks, the WO is left as-is (the app surfaces the gate when a user tries).
  // One write, only when a change is actually needed; never on cached/list reads.
  if (!opts.allowCached && wo.statusTaskId && workTaskComplete(wo) && cyclePreBilling(wo)) {
    try {
      const promoted = await autoPromoteToBilling(env, wo);
      if (promoted) return (await getWorkOrder(env, actionTaskId)) ?? wo;
    } catch (e) {
      if (e instanceof ZohoThrottleError) throw e;
      console.warn("promote-on-read failed (non-fatal):", e);
    }
  }
  return wo;
}

/** True when the STORED wo_cycle_status is still pre-billing (or unset) — i.e. Zoho hasn't been told the work is done. */
function cyclePreBilling(wo: WorkOrder): boolean {
  const raw = normalizeWoStatus(wo.cycleStatusRaw);
  return raw === "" || (WO_STATUS_PRE_BILLING as readonly string[]).includes(raw);
}

/** True when the Work Order Tasks task itself is Completed (the checkbox / all subtasks done). */
function workTaskComplete(wo: WorkOrder): boolean {
  const work = wo.tasks.find((t) => t.kind === "work");
  return !!work && work.taskStatus === TASK_STATUS_COMPLETED;
}

/**
 * Move a pre-billing WO to Ready for Billing because all its work tasks are complete.
 * Returns true when the status was written; false when the completion gate blocked it
 * (the caller decides whether to surface the gate message).
 */
async function autoPromoteToBilling(env: Env, wo: WorkOrder): Promise<boolean> {
  try {
    await assertRequestedPartsResolved(env, wo);
    assertUsedItemsInstalled(wo);
  } catch (e) {
    if (e instanceof CompletionGateError) return false;
    throw e;
  }
  const statusTaskId = wo.statusTaskId ?? (await ensureStatusTask(env, wo));
  await zoho.setTaskFields(env, wo.projectId, statusTaskId, { [woCycleStatusFieldName(env)]: "Ready for Billing" });
  // Keep the legacy lifecycle consistent: Action closed, Billing open.
  await zoho.setTaskCompleted(env, wo.projectId, wo.actionTaskId, true);
  return true;
}

/**
 * Find-or-create the WO's "Work Order Status" task (lazy safety net for WOs the one-time
 * migration hasn't touched). Seeds wo_cycle_status with the WO's CURRENT effective status so
 * nothing changes visibly, and tags it with the WO# so the board scan picks it up.
 */
export async function ensureStatusTask(env: Env, wo: WorkOrder): Promise<string> {
  if (wo.statusTaskId) return wo.statusTaskId;
  const seed = normalizeWoStatus(wo.woStatus) || "Not Scheduled";
  const t = await zoho.createTask(env, wo.projectId, {
    name: STATUS_TASK_NAME,
    taskListId: wo.taskListId,
    customFields: { [woCycleStatusFieldName(env)]: seed },
  });
  if (wo.workOrderNumber) {
    try { await zoho.setWorkOrderField(env, wo.projectId, t.id, wo.workOrderNumber); }
    catch (e) { if (e instanceof ZohoThrottleError) throw e; console.warn("ensureStatusTask: WO# tag failed (non-fatal):", e); }
  }
  wo.statusTaskId = t.id;
  return t.id;
}

//------------------------------------------------------------------------------
// ONE-TIME MIGRATION to the Zoho-native status model  (POST /admin/migrate-status)
//------------------------------------------------------------------------------
export interface MigrationRow {
  id: string;                 // Action task id (WO id)
  workOrderNumber: string;
  projectId: string;
  taskListId: string;
  hasStatusTask: boolean;
  fromStatus: string;         // what the app shows today
  toStatus: string;           // what wo_cycle_status will hold
  billingStatus: string;      // from the legacy KV flag (Billable / Non-Billable)
  workTaskStatus: string;     // Pending / Completed (from the native open/closed flag)
  billingTaskStatus: string;
  needs: string[];            // which writes this WO still needs
  skippedClosed?: string[];   // field writes NOT attempted because the task is closed (runtime fallback covers them)
  applied?: string[];         // writes performed (apply mode)
  error?: string;
}
export interface MigrationReport {
  dryRun: boolean;
  total: number;
  pending: number;            // WOs still needing at least one write (before this run)
  processed: number;
  stoppedBy?: string;         // e.g. "throttle" — rerun later to continue
  rows: MigrationRow[];
}

/**
 * Walk every WO (single portal scan) and bring it onto the new model:
 *   1. create the "Work Order Status" task (tagged with the WO#) seeded with the WO's CURRENT
 *      effective status — Completed → Closed, everything else name-for-name;
 *   2. write wo_task_status on the Work Order Tasks + Billing tasks from their open/closed flag;
 *   3. write billing_status on the Billing task from the legacy KV billable flag.
 * Idempotent: a WO that already has everything is skipped. `limit` caps how many WOs get
 * written per call (each needs ~4 Zoho calls; the portal allows ~100 per 2 min) — rerun
 * until `pending` is 0. Subtask wo_task_status is NOT back-filled here (their native
 * open/closed flag remains the fallback until they're next touched in the app).
 */
export async function migrateStatusModel(
  env: Env,
  opts: { apply: boolean; limit: number; onlyId?: string }
): Promise<MigrationReport> {
  const tasks = await listWoTaggedTasks(env, { refresh: true });
  const grouped = groupTicketsFromTasks(tasks);
  const taskStatusField = woTaskStatusFieldName(env);
  const rows: MigrationRow[] = [];
  for (const [taskListId, pair] of grouped) {
    if (!pair.action) continue;
    if (opts.onlyId && pair.action.id !== opts.onlyId) continue;
    const wo = woFromPortalTask(env, taskListId, pair.action, pair.billing, pair.others, pair.statusTask);
    // F3: the KV `billable:<id>` flag is gone (retired 2026-09-09; values preserved as
    // events by scripts/import-kv.ts). Read as the default (billable).
    const legacyBillable = true;
    const needs: string[] = [];
    if (!pair.statusTask) needs.push("status-task");
    else if (!taskField(pair.statusTask, woCycleStatusFieldName(env))) needs.push("cycle-status");
    // Zoho refuses field writes on a CLOSED task ("cannot update a closed task"), and the runtime
    // reads a closed task as Completed anyway (taskStatusOf fallback) — so closed tasks are left
    // alone here and reported as skipped. billing_status on a closed Billing task is likewise skipped
    // (defaults to Billable on read; hand-fix the few Non-Billable closed WOs in Zoho if needed).
    const skipped: string[] = [];
    if (!taskField(pair.action, taskStatusField)) (pair.action.isCompleted ? skipped : needs).push("work-task-status");
    if (pair.billing && !taskField(pair.billing, taskStatusField)) (pair.billing.isCompleted ? skipped : needs).push("billing-task-status");
    if (pair.billing && !taskField(pair.billing, billingStatusFieldName(env))) (pair.billing.isCompleted ? skipped : needs).push("billing-status");
    rows.push({
      id: pair.action.id,
      workOrderNumber: wo.workOrderNumber,
      projectId: wo.projectId,
      taskListId,
      hasStatusTask: !!pair.statusTask,
      fromStatus: wo.woStatus,
      toStatus: normalizeWoStatus(wo.woStatus),
      billingStatus: pair.billing && taskField(pair.billing, billingStatusFieldName(env))
        ? taskField(pair.billing, billingStatusFieldName(env))
        : billingStatusFromBoolean(legacyBillable),
      workTaskStatus: pair.action.isCompleted ? TASK_STATUS_COMPLETED : TASK_STATUS_PENDING,
      billingTaskStatus: pair.billing?.isCompleted ? TASK_STATUS_COMPLETED : TASK_STATUS_PENDING,
      needs,
      skippedClosed: skipped.length ? skipped : undefined,
    });
  }
  const pendingRows = rows.filter((r) => r.needs.length);
  const report: MigrationReport = { dryRun: !opts.apply, total: rows.length, pending: pendingRows.length, processed: 0, rows };
  if (!opts.apply) return report;

  for (const row of pendingRows.slice(0, Math.max(1, opts.limit))) {
    row.applied = [];
    try {
      if (row.needs.includes("status-task")) {
        const t = await zoho.createTask(env, row.projectId, {
          name: STATUS_TASK_NAME,
          taskListId: row.taskListId,
          customFields: { [woCycleStatusFieldName(env)]: row.toStatus || "Not Scheduled" },
        });
        if (row.workOrderNumber) await zoho.setWorkOrderField(env, row.projectId, t.id, row.workOrderNumber);
        row.applied.push("status-task");
      } else if (row.needs.includes("cycle-status")) {
        const st = grouped.get(row.taskListId)?.statusTask;
        if (st) await zoho.setTaskFields(env, row.projectId, st.id, { [woCycleStatusFieldName(env)]: row.toStatus || "Not Scheduled" });
        row.applied.push("cycle-status");
      }
      if (row.needs.includes("work-task-status")) {
        await zoho.setTaskFields(env, row.projectId, row.id, { [taskStatusField]: row.workTaskStatus });
        row.applied.push("work-task-status");
      }
      const billingId = grouped.get(row.taskListId)?.billing?.id;
      if (billingId && (row.needs.includes("billing-task-status") || row.needs.includes("billing-status"))) {
        const fields: Record<string, string> = {};
        if (row.needs.includes("billing-task-status")) fields[taskStatusField] = row.billingTaskStatus;
        if (row.needs.includes("billing-status")) fields[billingStatusFieldName(env)] = row.billingStatus;
        await zoho.setTaskFields(env, row.projectId, billingId, fields);
        row.applied.push(...Object.keys(fields).map((k) => (k === taskStatusField ? "billing-task-status" : "billing-status")));
      }
      report.processed++;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
      if (e instanceof ZohoThrottleError) { report.stoppedBy = "throttle"; break; }
      // Cloudflare's per-invocation subrequest cap (live 2026-09-09 at ~10 WOs): stop, rerun later.
      if (/Too many subrequests/i.test(row.error)) { report.stoppedBy = "subrequest-limit"; break; }
    }
  }
  await invalidateTaskCaches(env);
  report.pending = Math.max(0, report.pending - report.processed);
  return report;
}

//------------------------------------------------------------------------------
// TASK STATUS  (PATCH /work-orders/:id/tasks/:taskId  { taskStatus })
//------------------------------------------------------------------------------
/**
 * Set a work task's wo_task_status (Pending | Completed). `taskId` may be the Work Order
 * Tasks task, one of its subtasks, or the Billing task. Writes the pick-list + the native
 * open/closed status in one PATCH, then reconciles the WO:
 *   - Work Order Tasks → Completed while pre-billing  ⇒ auto Ready for Billing (gate-checked).
 *   - Work Order Tasks → Pending while Ready for Billing / Waiting Payment ⇒ back to the
 *     calendar-driven flow (re-derived), mirroring today's "uncheck reopens the work" behaviour.
 *   - Billing task: field write only — the close-out decision (→ Closed) is the app's popup,
 *     which sends PATCH /work-orders/:id { woStatus: "Closed" }.
 *   - Subtasks: field write only; the app marks the parent Completed when the last one is done.
 */
export async function setTaskStatus(env: Env, actionTaskId: string, taskId: string, taskStatus: string): Promise<TaskStatusResult | null> {
  const existing = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!existing) return null;
  const projectId = existing.projectId;
  await writeTaskStatus(env, projectId, taskId, taskStatus);

  let autoPromoted = false;
  let gateMessage: string | null = null;
  if (taskId === existing.actionTaskId) {
    const cur = normalizeWoStatus(existing.woStatus);
    if (taskStatus === TASK_STATUS_COMPLETED && cyclePreBilling(existing)) {
      try {
        await assertRequestedPartsResolved(env, existing);
        assertUsedItemsInstalled(existing);
        const statusTaskId = existing.statusTaskId ?? (await ensureStatusTask(env, existing));
        await zoho.setTaskFields(env, projectId, statusTaskId, { [woCycleStatusFieldName(env)]: "Ready for Billing" });
        autoPromoted = true;
      } catch (e) {
        if (e instanceof CompletionGateError) gateMessage = e.message; else throw e;
      }
    } else if (taskStatus === TASK_STATUS_PENDING && (cur === "Ready for Billing" || cur === "Waiting Payment")) {
      // Work reopened: return to the scheduling flow (auto label, re-derived by the mirror).
      const statusTaskId = existing.statusTaskId ?? (await ensureStatusTask(env, existing));
      await zoho.setTaskFields(env, projectId, statusTaskId, { [woCycleStatusFieldName(env)]: CYCLE_STATUS_LABEL[deriveScheduleStatus(existing.visits, "action")] });
      if (existing.billingTaskId) await writeTaskStatus(env, projectId, existing.billingTaskId, TASK_STATUS_PENDING);
    }
  }
  const updated = (await getWorkOrder(env, actionTaskId)) ?? existing;
  return { workOrder: updated, autoPromoted, gateMessage };
}

//------------------------------------------------------------------------------
// DELETE / CANCEL  (removes the WO's ticket task list + its calendar events)
//------------------------------------------------------------------------------
export async function deleteWorkOrder(env: Env, actionTaskId: string): Promise<boolean> {
  const wo = await getWorkOrder(env, actionTaskId);
  if (!wo) return false;

  // 1) Remove every scheduled visit's calendar event (best-effort — a WO delete
  //    should not fail just because a calendar event was already gone).
  for (const v of wo.visits) {
    if (v.eventId) {
      try {
        await cal.deleteEvent(env, v.calendarId, v.eventId);
      } catch (e) {
        console.warn(`deleteWorkOrder: calendar event ${v.eventId} not removed:`, e);
      }
    }
  }

  // 2) Delete the ticket's task list, which removes the Action + Billing tasks and
  //    any Action subtasks with it. Each WO owns its own task list, so this cleanly
  //    removes the whole work order.
  await zoho.deleteTaskList(env, wo.projectId, wo.taskListId);
  return true;
}

//------------------------------------------------------------------------------
// PATCH
//------------------------------------------------------------------------------
export async function updateWorkOrder(
  env: Env,
  actionTaskId: string,
  patch: UpdateWorkOrderInput
): Promise<WorkOrder | null> {
  // Pre-read may come from the cached scan (ids, current status, visits); the post-write
  // re-hydrate below stays LIVE so the returned WO reflects this request's writes.
  const existing = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!existing) return null;

  const projectId = existing.projectId;

  // Notes -> Action description. Visits now live as "Schedule" subtasks, so the
  // description is CLEAN notes only (no base64 trailer / "Scheduled Visits" section).
  if (patch.notes !== undefined) {
    await zoho.setTaskDescription(env, projectId, actionTaskId, patch.notes);
  }

  // Access codes -> write back to the PROJECT (single source of truth).
  if (patch.accessCodes) {
    await zoho.updateAccessCodes(env, projectId, patch.accessCodes);
    await invalidateProjectCaches(env, projectId);
  }

  // Billing status → the Billing task's `billing_status` pick-list (legacy `billable` boolean
  // maps onto it). Best-effort like the other pick-list writes.
  const billingPatch =
    patch.billingStatus !== undefined ? patch.billingStatus :
    patch.billable !== undefined ? billingStatusFromBoolean(patch.billable) : undefined;
  if (billingPatch !== undefined && existing.billingTaskId) {
    try {
      await zoho.setTaskFields(env, projectId, existing.billingTaskId, { [billingStatusFieldName(env)]: billingPatch });
    } catch (e) {
      if (e instanceof ZohoThrottleError) throw e;
      console.warn("updateWorkOrder: billing_status write failed (non-fatal):", e);
    }
  }

  // Status change — accept EITHER `woStatus` (takes precedence; legacy spellings normalized)
  // or the legacy 3-state `status`. Both resolve to (targetLifecycle = which tasks open/close)
  // + (newWoStatusLabel = what to write into wo_cycle_status). The final mirror call (below)
  // writes the label to the Status task; a back-half label sticks, scheduling labels re-derive.
  let newWoStatusLabel: string | undefined;
  {
    let targetLifecycle: WorkOrderStatus | null = null;
    let targetLabel: string | undefined;
    if (patch.woStatus !== undefined) {
      targetLabel = normalizeWoStatus(patch.woStatus);   // validated at the boundary
      targetLifecycle = woStatusToLifecycle(targetLabel);
    } else if (patch.status) {
      targetLifecycle = patch.status;
      targetLabel =
        patch.status === "completed" ? "Closed" :
        patch.status === "billing" ? "Ready for Billing" :
        undefined;                                         // "action" -> scheduling (auto), let mirror derive
    }
    if (targetLifecycle) {
      // COMPLETION GATE: refuse to close the work (billing/completed lifecycle — i.e.
      // Ready for Billing / Waiting Payment / Closed) while any requested item is
      // still pending or a used item isn't marked installed. Fails open on a purchasing
      // hiccup (never wedges).
      if (targetLifecycle === "billing" || targetLifecycle === "completed") {
        await assertRequestedPartsResolved(env, existing);
        assertUsedItemsInstalled(existing);
      }
      // Task states follow the WO status (wo_task_status + native open/closed in one PATCH each):
      //   action:    Work Order Tasks Pending (+ Billing Pending) — this includes On Hold /
      //              Active Monitoring, otherwise a Completed work task would immediately
      //              re-promote the WO to Ready for Billing on the next read;
      //   billing:   Work Order Tasks Completed, Billing Pending;
      //   completed: both Completed.
      if (targetLifecycle === "action") {
        await writeTaskStatus(env, projectId, existing.actionTaskId, TASK_STATUS_PENDING);
        if (existing.billingTaskId) await writeTaskStatus(env, projectId, existing.billingTaskId, TASK_STATUS_PENDING);
      } else if (targetLifecycle === "billing") {
        await writeTaskStatus(env, projectId, existing.actionTaskId, TASK_STATUS_COMPLETED);
        if (existing.billingTaskId) await writeTaskStatus(env, projectId, existing.billingTaskId, TASK_STATUS_PENDING);
      } else {
        await writeTaskStatus(env, projectId, existing.actionTaskId, TASK_STATUS_COMPLETED);
        if (existing.billingTaskId) await writeTaskStatus(env, projectId, existing.billingTaskId, TASK_STATUS_COMPLETED);
      }
      newWoStatusLabel = targetLabel;
      // Make sure the Status task exists so the label has a real home in Zoho.
      if (!existing.statusTaskId) await ensureStatusTask(env, existing);
    }
  }

  // Schedule -> operate on the FIRST (earliest) visit so the UI's existing
  // "change schedule" action stays consistent with the visits list. Patch it if
  // it exists, otherwise create the first visit (when a real start+end are given).
  if (patch.schedule) {
    const first = earliestVisit(existing.visits);
    const visitPatch: UpdateVisitInput = {
      start: patch.schedule.start,
      end: patch.schedule.end,
      attendees: patch.schedule.attendees,
      calendarId: patch.schedule.calendarId,
    };
    if (first) {
      await updateVisit(env, actionTaskId, first.id, visitPatch);
    } else if (patch.schedule.start && patch.schedule.end) {
      await addVisit(env, actionTaskId, {
        start: patch.schedule.start,
        end: patch.schedule.end,
        attendees: patch.schedule.attendees,
        calendarId: patch.schedule.calendarId,
      });
    }
  }

  // CompanyCam URL -> Action task custom field. NO-OP unless the field is configured
  // AND the patch supplied it. Empty string CLEARS it. BEST-EFFORT: a field-write
  // hiccup must not fail the PATCH — we warn and continue.
  const companyCamField = companyCamFieldName(env);
  if (companyCamField && patch.companyCamUrl !== undefined) {
    try {
      await zoho.setTaskFields(env, projectId, actionTaskId, { [companyCamField]: patch.companyCamUrl });
    } catch (e) {
      console.warn("updateWorkOrder: CompanyCam URL write failed (non-fatal):", e);
    }
  }

  // Provision-ticket URL -> Action task `provision` custom field. PRESENT in the body
  // => update it (an empty string CLEARS it); ABSENT => leave the stored value unchanged
  // (never overwrite with empty). TOLERANT: the field may not exist in Zoho yet, so the
  // write is best-effort — a missing-field / any write hiccup is caught and non-fatal.
  if (patch.provision !== undefined) {
    try {
      await zoho.setTaskFields(env, projectId, actionTaskId, { [provisionFieldName(env)]: patch.provision });
    } catch (e) {
      console.warn("updateWorkOrder: provision URL write failed (non-fatal — field may not exist yet):", e);
    }
  }
  if (patch.woType !== undefined) {
    try {
      await zoho.setTaskFields(env, projectId, actionTaskId, { [woTypeFieldName(env)]: patch.woType });
    } catch (e) {
      console.warn("updateWorkOrder: wo_type write failed (non-fatal — field/option may not exist yet):", e);
    }
  }

  // Refresh the Zoho schedule mirror against the final state (covers a status-only
  // change, e.g. completing the WO should clear a "Needs Reschedule"). Pass the new
  // woStatus label so a manual back-half status is written (and sticks); if the change
  // didn't set a label, fall back to the WO's current woStatus so an existing back-half
  // value is preserved rather than clobbered by the scheduling re-derivation.
  const updated = await getWorkOrder(env, actionTaskId);
  if (updated) {
    const mirrorLabel = newWoStatusLabel ?? updated.woStatus;
    await mirrorScheduleFields(env, projectId, actionTaskId, updated.visits, updated.status, mirrorLabel, updated.statusTaskId ?? existing.statusTaskId);
    // The field write above happened AFTER getWorkOrder read it, so reflect the effective
    // woStatus in the returned object: a back-half label sticks; otherwise it's the
    // freshly-derived scheduling state.
    updated.woStatus = (WO_STATUS_BACK_HALF as readonly string[]).includes(normalizeWoStatus(mirrorLabel))
      ? normalizeWoStatus(mirrorLabel)
      : CYCLE_STATUS_LABEL[deriveScheduleStatus(updated.visits, updated.status)];
    if (billingPatch !== undefined) {
      updated.billingStatus = billingPatch;
      updated.billable = billingPatch === "Billable";
    }
  }
  return updated;
}

/**
 * Completion gate: refuse to close a WO (move to billing/completed) while it still
 * has requested parts that aren't DONE. "Requested parts" = purchasing rows whose
 * sourceWoId is this WO's actionTaskId; "done" = status is in the configured done set
 * (config.orderDoneStatuses, default Installed / Not Needed / Cancelled), compared
 * case-insensitively + trimmed. Throws a CompletionGateError (mapped to HTTP 409)
 * listing the unresolved part names.
 *
 * Uses includeArchived=true so the gate sees ALL of the WO's requested items,
 * including archived ones. Archived items are done (that's why they were archived),
 * so they pass; any active Received / On Order / etc. item blocks.
 *
 * FAIL-OPEN: a purchasing lookup failure must NOT wedge completion — we warn and
 * allow the status change rather than blocking on an unrelated purchasing hiccup.
 */
async function assertRequestedPartsResolved(env: Env, wo: WorkOrder): Promise<void> {
  let requested: PurchaseItem[];
  try {
    const all = await listPurchasing(env, undefined, true);
    requested = all.filter((p) => p.sourceWoId === wo.id);
  } catch (e) {
    console.warn("completion gate: listPurchasing failed — failing open (not blocking):", e);
    return;
  }

  const resolved = orderDoneStatuses(env).map((s) => s.trim().toLowerCase());
  const unresolved = requested.filter((p) => !resolved.includes((p.status ?? "").trim().toLowerCase()));
  if (unresolved.length) {
    const names = unresolved.map((p) => `"${p.item}"`).join(", ");
    throw new CompletionGateError(
      `Cannot complete: ${unresolved.length} requested part(s) still pending — not yet received or marked not needed — ${names}.`
    );
  }
}

/**
 * Completion gate #2: refuse to close a WO (move to billing/completed) while any used
 * item is still NOT marked installed. Every used item — manual or auto-created from a
 * part — must be confirmed installed before the ticket bills. Throws a
 * CompletionGateError (HTTP 409) naming the un-confirmed items. Operates on the
 * already-hydrated WO (usedItems carry the installed flag), so no extra fetch.
 */
function assertUsedItemsInstalled(wo: WorkOrder): void {
  const notInstalled = wo.usedItems.filter((i) => i.installed !== true);
  if (notInstalled.length) {
    const names = notInstalled.map((i) => `"${i.item}"`).join(", ");
    throw new CompletionGateError(
      `Cannot complete: ${notInstalled.length} used item(s) not marked installed — ${names}.`
    );
  }
}

//------------------------------------------------------------------------------
// VISITS — legible per-WO storage (2026-08-23). Each visit is a SUBTASK under a
// "Schedule" task on the WO's task list — parallel to "Items". The machine fields
// (start/end/attendees/calendar/eventId/link) live as readable labeled lines in the
// subtask description; visit.id == the subtask id. Retires the base64 description
// trailer + wo_schedule field. Legacy trailers are still READ as a fallback until
// migration. Add / update / remove each map to a subtask op + its calendar event.
//------------------------------------------------------------------------------

/** Per-WO "Schedule" container task holding visit subtasks. */
const SCHEDULE_TASK_NAME = "Schedule";

/** Find the WO's "Schedule" container task (in its task list); create it if missing. */
async function ensureScheduleTask(env: Env, projectId: string, taskListId: string): Promise<string> {
  const tasks = await zoho.getTasksByProject(env, projectId);
  const existing = tasks.find((t) => t.taskListId === taskListId && t.name === SCHEDULE_TASK_NAME);
  if (existing) return existing.id;
  const created = await zoho.createTask(env, projectId, { name: SCHEDULE_TASK_NAME, taskListId });
  return created.id;
}

/** Legible subtask name for a visit. */
function visitSubtaskName(v: { start: string | null; label: string | null }): string {
  const when = v.start ? formatDateTimeET(v.start) : "unscheduled";
  return `Visit — ${when}${v.label ? ` — ${v.label}` : ""}`;
}

/** The custom field carrying a visit subtask's machine-readable round-trip blob (default "wo_schedule"). */
function visitsFieldName(env: Env): string {
  return env.ZOHO_VISITS_FIELD || "wo_schedule";
}

/**
 * CLEAN human-readable visit description — NO machine token, NO raw ISO block. The round-trip
 * machine data lives in the visit subtask's own `wo_schedule` custom field (see visitFieldBlob),
 * which does NOT render in the description body. visitFromSubtask reads that field first, then
 * falls back to the legacy `fhi-visit-v1:` token / labeled-line parsers for un-migrated visits.
 */
function visitSubtaskDescription(v: Visit | Omit<Visit, "id">): string {
  const lines: string[] = ["Scheduled visit"];
  if (v.start && v.end) {
    lines.push(`When: ${formatDateTimeET(v.start)} – ${formatDateTimeET(v.end)} (ET)`);
  } else if (v.start) {
    lines.push(`When: ${formatDateTimeET(v.start)} (ET)`);
  } else {
    lines.push("When: (unscheduled)");
  }
  const techs = (v.attendees ?? []).filter(Boolean);
  lines.push(`Tech(s): ${techs.length ? techs.join(", ") : "unassigned"}`);
  if (v.label && v.label.trim()) lines.push(`Label: ${v.label.trim()}`);
  if (v.htmlLink && v.htmlLink.trim()) lines.push(`Calendar event: ${v.htmlLink.trim()}`);
  return lines.join("\n");
}

/**
 * Machine-readable round-trip blob written to the visit subtask's `wo_schedule` custom field.
 * base64url of the full Visit JSON (start/end/attendees/label/calendarId/eventId/htmlLink) so a
 * visit round-trips WITHOUT any token in the description body. Read back by visitFromSubtask.
 */
function visitFieldBlob(v: Visit | Omit<Visit, "id">): string {
  const techs = (v.attendees ?? []).filter(Boolean);
  const payload = {
    start: v.start ?? null,
    end: v.end ?? null,
    attendees: techs,
    label: v.label ?? null,
    calendarId: v.calendarId ?? "",
    eventId: v.eventId ?? null,
    htmlLink: v.htmlLink ?? null,
    confirmed: v.confirmed !== false,
    confirmTodoId: v.confirmTodoId ?? null,
    remote: v.remote === true,
  };
  return b64urlEncode(JSON.stringify(payload));
}

/**
 * Parse a visit subtask back into a Visit (id = subtask id). Read priority:
 *   a. the subtask's `wo_schedule` custom field (the CLEAN-format machine blob) — source of truth,
 *   b. else the legacy `fhi-visit-v1:` token in the description,
 *   c. else the legacy `Start:/End:/...` labeled-line parser,
 * so both migrated and un-migrated visits round-trip with all fields preserved.
 */
function visitFromSubtask(env: Env, task: zoho.ZohoTask): Visit {
  // (a) CLEAN-format machine blob on the subtask's own wo_schedule field.
  const blob = (task.raw?.[visitsFieldName(env)] ?? task.customFields[visitsFieldName(env)]) as unknown;
  if (typeof blob === "string" && blob.trim()) {
    try {
      const obj = JSON.parse(b64urlDecode(blob.trim())) as Partial<Visit>;
      const attendees = Array.isArray(obj.attendees)
        ? obj.attendees.filter((s): s is string => typeof s === "string" && !!s.trim())
        : [];
      return {
        id: task.id,
        start: obj.start ?? null,
        end: obj.end ?? null,
        attendees,
        label: obj.label ?? null,
        calendarId: obj.calendarId ?? "",
        eventId: obj.eventId ?? null,
        htmlLink: obj.htmlLink ?? null,
        confirmed: obj.confirmed !== false,
        confirmTodoId: obj.confirmTodoId ?? null,
        remote: obj.remote === true,
      };
    } catch {
      /* fall through to the legacy token / labeled-line parsers */
    }
  }
  const desc = htmlToText(task.description ?? "");
  const tok = desc.match(VISIT_TOKEN_RE);
  if (tok) {
    try {
      const obj = JSON.parse(b64urlDecode(tok[1])) as Partial<Visit>;
      const attendees = Array.isArray(obj.attendees)
        ? obj.attendees.filter((s): s is string => typeof s === "string" && !!s.trim())
        : [];
      return {
        id: task.id,
        start: obj.start ?? null,
        end: obj.end ?? null,
        attendees,
        label: obj.label ?? null,
        calendarId: obj.calendarId ?? "",
        eventId: obj.eventId ?? null,
        htmlLink: obj.htmlLink ?? null,
        confirmed: obj.confirmed !== false,
        confirmTodoId: obj.confirmTodoId ?? null,
        remote: obj.remote === true,
      };
    } catch {
      /* fall through to the legacy labeled-line parser */
    }
  }
  // Legacy visits (pre-token): parse the Start:/End:/Attendees:/Calendar:/Label:/Google Event:/Link: lines.
  const get = (key: string): string => {
    const m = desc.match(new RegExp(`^${key}:\\s*(.*)$`, "mi"));
    return m ? m[1].trim() : "";
  };
  const attendees = get("Attendees")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: task.id,
    start: get("Start") || null,
    end: get("End") || null,
    attendees,
    label: get("Label") || null,
    calendarId: get("Calendar") || "",
    eventId: get("Google Event") || null,
    htmlLink: get("Link") || null,
    confirmed: true,
    confirmTodoId: null,
    remote: false,
  };
}

/**
 * True when a subtask is a VISIT subtask, identified by DESCRIPTION MARKERS (never field
 * presence — the Action task also carries a `wo_schedule` field, value "" after mirror, and the
 * pick-lists order_status/to_do_s now default on EVERY task). Markers, in order:
 *   - CLEAN format: a `Scheduled visit` header line, or a `When:` / `Calendar event:` line,
 *   - legacy: the `fhi-visit-v1:` token, or the `Start:` / `Google Event:` labeled lines.
 * The `Scheduled visit` match is line-anchored with a word boundary so the Action task's old
 * `── Scheduled Visits ──` section header (plural) can never match. Mutually exclusive from items
 * (`[src-wo-id:]`) and todos (`fhi-todo-v1:`): Action/Billing carry none of these markers.
 */
function isVisitSubtask(_env: Env, task: zoho.ZohoTask): boolean {
  const desc = htmlToText(task.description ?? "");
  return (
    /^Scheduled visit\b/mi.test(desc) ||
    /^When:/mi.test(desc) ||
    /^Calendar event:/mi.test(desc) ||
    VISIT_TOKEN_RE.test(desc) ||
    /^Start:/mi.test(desc) ||
    /^Google Event:/mi.test(desc)
  );
}

/**
 * Read a WO's visits from its "Schedule" subtasks. `woTagged` is the set of tasks carrying
 * this WO's work_order_hash (from the proven portal filter); visit subtasks are the ones with
 * the Start:/Google Event: markers. Falls back to the legacy base64 description trailer for
 * un-migrated WOs (so nothing disappears before migration).
 */
function readVisitsForWo(env: Env, action: zoho.ZohoTask, woTagged: zoho.ZohoTask[]): Visit[] {
  const visits = woTagged.filter((t) => isVisitSubtask(env, t)).map((t) => visitFromSubtask(env, t));
  if (visits.length) return sortVisits(visits);
  return readVisits(action.description ?? "");
}

/**
 * Create a visit subtask under the WO's Schedule task; returns the new subtask id (= visit id).
 * Tags the subtask with work_order_hash so the proven portal filter (used everywhere else) finds
 * it — Zoho's `has_parents` query proved unreliable, but the work_order_hash filter returns subtasks.
 */
async function createVisitSubtask(
  env: Env,
  projectId: string,
  taskListId: string,
  woNumber: string,
  v: Omit<Visit, "id">
): Promise<string> {
  const scheduleTaskId = await ensureScheduleTask(env, projectId, taskListId);
  const task = await zoho.createTask(env, projectId, {
    name: visitSubtaskName(v),
    taskListId,
    description: visitSubtaskDescription({ ...v, id: "" }),
    parentTaskId: scheduleTaskId,
  });
  try {
    // work_order_hash tag (for the portal filter) + the CLEAN-format round-trip blob on the
    // subtask's own wo_schedule field — one call so the machine data never lives in the body.
    await zoho.setTaskFields(env, projectId, task.id, {
      [woFieldName(env)]: woNumber,
      [visitsFieldName(env)]: visitFieldBlob(v),
    });
  } catch (e) {
    console.warn("createVisitSubtask: work_order_hash / wo_schedule write failed (non-fatal):", e);
  }
  return task.id;
}

/** Portal query for every task tagged with a WO number (work_order_hash contains "-WO-"). */
/**
 * The ONE portal-wide "-WO-" task query every list surface depends on (board, schedule, projects
 * tab, items, billing, todos), cached briefly (per-isolate memory). Rate-limit relief 2026-09-03: this
 * was 4–6 paginated /tasks requests per call and the UI called it from six screens plus twice per
 * WO open. Any app write (non-GET request) invalidates it — see index.ts; edits made directly in
 * Zoho show up within WO_TAGGED_FRESH_MS. Callers get a fresh deep copy (some mutate rows).
 */
const WO_TAGGED_FRESH_MS = 45_000;
export const WO_TAGGED_CACHE_KEY = "tasks:woTagged";
export async function listWoTaggedTasks(env: Env, opts: { refresh?: boolean } = {}): Promise<zoho.ZohoTask[]> {
  const r = await cached(env, WO_TAGGED_CACHE_KEY, { freshMs: WO_TAGGED_FRESH_MS, staleTtlS: 30 * 60, refresh: opts.refresh }, () =>
    zoho.listPortalTasksByFilter(env, woTaggedFilter(env))
  );
  return JSON.parse(JSON.stringify(r.value)) as zoho.ZohoTask[];
}
/** Drop the task-list caches after any write that touches tasks (router calls this on non-GET). */
export async function invalidateTaskCaches(env: Env): Promise<void> {
  await cacheDelete(env, WO_TAGGED_CACHE_KEY);
}

function woTaggedFilter(env: Env): string {
  return JSON.stringify({
    criteria: [{ field_name: woFieldName(env), criteria_condition: "contains", value: ["-WO-"] }],
    pattern: "1",
  });
}

/** Add a new visit: create its calendar event, then a legible Schedule subtask. */
export async function addVisit(
  env: Env,
  actionTaskId: string,
  input: AddVisitInput
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;

  const projectId = existing.projectId;
  const calendarId = input.calendarId ?? env.DEFAULT_CALENDAR_ID;
  const attendees = input.attendees ?? [];

  const pending = input.pending === true;
  const remote = input.remote === true;
  const body = cal.buildEventBody({
    fullWoNumber: existing.workOrderNumber,
    client: existing.client,
    subject: existing.subject,
    siteAddress: existing.siteAddress,
    notes: existing.notes,
    accessCodesText: formatAccessCodes(existing.accessCodes),
    woLink: woDetailLink(env, existing.id, existing.workOrderNumber),
    start: input.start,
    end: input.end,
    attendees,
    tentative: pending,
  });
  const ev = await cal.insertEvent(env, calendarId, body);

  // TENTATIVE appointment: only when notifyConfirmer is set (default OFF) do we ping the
  // scheduling confirmer in Cliq (#Scheduling) and create their "confirm this appointment"
  // to-do. Both best-effort — a hiccup must not fail the visit create. The to-do id rides on
  // the visit so /confirm can resolve it later. Without notifyConfirmer the visit is still
  // TENTATIVE (in-app confirm), just no ping/to-do.
  let confirmTodoId: string | null = null;
  const notifyConfirmer = input.notifyConfirmer === true;
  if (pending && notifyConfirmer) {
    const confirmer = await schedulingConfirmerName(env);
    const whenLabel = input.start ? formatDateTimeET(input.start) : "unscheduled";
    const shortWo = shortWo_(existing.workOrderNumber);
    try {
      await postToCliq(
        env.CLIQ_SCHEDULING_WEBHOOK,
        `TENTATIVE appointment needs confirmation\n@${confirmer}\n${existing.client} \u00b7 ${shortWo} \u2014 ${existing.subject}\nWhen: ${whenLabel} (ET)\nConfirm it in the app to post it officially.`
      );
    } catch (e) {
      console.warn("addVisit: Cliq scheduling notify failed (non-fatal):", e);
    }
    try {
      const todo = await addTodo(env, actionTaskId, {
        title: `Confirm appointment \u2014 ${whenLabel}`,
        status: DEFAULT_TODO_STATUS,
        priority: "high",
        assignee: confirmer,
        notes: `Tentative visit for ${existing.client} (${shortWo}). Confirm in the app to remove the TENTATIVE marker and post it officially.`,
      });
      confirmTodoId = todo?.id ?? null;
    } catch (e) {
      console.warn("addVisit: confirm-todo create failed (non-fatal):", e);
    }
  }

  const draft = {
    start: input.start,
    end: input.end,
    attendees,
    label: input.label ?? null,
    calendarId,
    eventId: ev.id,
    htmlLink: ev.htmlLink ?? null,
    confirmed: !pending,
    confirmTodoId,
    remote,
  };
  // Persist the visit as a legible subtask under the WO's "Schedule" task (id = subtask id).
  const visitId = await createVisitSubtask(env, projectId, existing.taskListId, existing.workOrderNumber, draft);
  const visit: Visit = { id: visitId, ...draft };
  const visits = sortVisits([...existing.visits, visit]);
  await mirrorScheduleFields(env, projectId, actionTaskId, visits, existing.status, existing.woStatus, existing.statusTaskId);

  return getWorkOrder(env, actionTaskId);
}

/** Short WO number ("WO-2026-0028") off the composite ref; falls back to the whole string. */
function shortWo_(full: string): string {
  return (String(full || "").match(/WO-\d{4}-\d+/i) || [full || ""])[0];
}

/** The configured scheduling confirmer (Cliq tag + to-do assignee); defaults to "Angie Hartman". */
async function schedulingConfirmerName(env: Env): Promise<string> {
  try {
    const cfg = await getAdminConfig(env);
    if (cfg.schedulingConfirmer && cfg.schedulingConfirmer.trim()) return cfg.schedulingConfirmer.trim();
  } catch {
    /* fall through to the default */
  }
  return "Angie Hartman";
}

/**
 * Confirm a tentative visit: rebuild its Google event description WITHOUT the bold TENTATIVE
 * marker, flip the stored `confirmed` flag to true, and resolve the linked "confirm appointment"
 * to-do. External writes are best-effort. Returns the refreshed WorkOrder, or null if the WO or
 * visit id isn't found.
 */
export async function confirmVisit(
  env: Env,
  actionTaskId: string,
  visitId: string
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;
  const idx = existing.visits.findIndex((v) => v.id === visitId);
  if (idx < 0) return null;

  const current = existing.visits[idx];
  const projectId = existing.projectId;

  if (current.eventId && current.start && current.end) {
    const body = cal.buildEventBody({
      fullWoNumber: existing.workOrderNumber,
      client: existing.client,
      subject: existing.subject,
      siteAddress: existing.siteAddress,
      notes: existing.notes,
      accessCodesText: formatAccessCodes(existing.accessCodes),
      woLink: woDetailLink(env, existing.id, existing.workOrderNumber),
      start: current.start,
      end: current.end,
      attendees: current.attendees,
      tentative: false,
    });
    try {
      const b = body as { summary?: string; description?: string };
      await cal.patchEvent(env, current.calendarId, current.eventId, {
        summary: b.summary,
        description: b.description ?? "",
      });
    } catch (e) {
      console.warn("confirmVisit: event summary/description patch failed (non-fatal):", e);
    }
  }

  if (current.confirmTodoId) {
    try {
      await updateTodo(env, actionTaskId, current.confirmTodoId, { status: "Completed" });
    } catch (e) {
      console.warn("confirmVisit: resolve confirm-todo failed (non-fatal):", e);
    }
  }

  const updated: Visit = { ...current, confirmed: true };
  await zoho.setTaskDescription(env, projectId, visitId, visitSubtaskDescription(updated));
  try {
    await zoho.setTaskFields(env, projectId, visitId, {
      [visitsFieldName(env)]: visitFieldBlob(updated),
    });
  } catch (e) {
    console.warn("confirmVisit: subtask blob update failed (non-fatal):", e);
  }
  const visits = [...existing.visits];
  visits[idx] = updated;
  await mirrorScheduleFields(env, projectId, actionTaskId, sortVisits(visits), existing.status, existing.woStatus, existing.statusTaskId);

  return getWorkOrder(env, actionTaskId);
}

/**
 * Update a visit: patch its calendar event (start/end/attendees), or create the
 * event if the visit had none yet (e.g. a migrated date-less visit that just got
 * dates). Returns null if the WO or the visit id isn't found.
 */
export async function updateVisit(
  env: Env,
  actionTaskId: string,
  visitId: string,
  patch: UpdateVisitInput
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;
  const idx = existing.visits.findIndex((v) => v.id === visitId);
  if (idx < 0) return null;

  const projectId = existing.projectId;
  const current = existing.visits[idx];
  const calendarId = patch.calendarId ?? current.calendarId;
  const start = patch.start ?? current.start;
  const end = patch.end ?? current.end;
  const attendees = patch.attendees ?? current.attendees;
  const label = patch.label !== undefined ? patch.label : current.label;

  let eventId = current.eventId;
  let htmlLink = current.htmlLink;

  if (eventId) {
    // Patch the existing event — only send the fields that actually changed.
    const eventPatch: Record<string, unknown> = {};
    if (patch.start !== undefined) eventPatch.start = { dateTime: patch.start };
    if (patch.end !== undefined) eventPatch.end = { dateTime: patch.end };
    if (patch.attendees !== undefined) eventPatch.attendees = attendees.map((e) => ({ email: e }));
    if (Object.keys(eventPatch).length) {
      const ev = await cal.patchEvent(env, calendarId, eventId, eventPatch);
      htmlLink = ev.htmlLink ?? htmlLink;
    }
  } else if (start && end) {
    // No event yet — create one now.
    const body = cal.buildEventBody({
      fullWoNumber: existing.workOrderNumber,
      client: existing.client,
      subject: existing.subject,
      siteAddress: existing.siteAddress,
      notes: existing.notes,
      accessCodesText: formatAccessCodes(existing.accessCodes),
      woLink: woDetailLink(env, existing.id, existing.workOrderNumber),
      start,
      end,
      attendees,
    });
    const ev = await cal.insertEvent(env, calendarId, body);
    eventId = ev.id;
    htmlLink = ev.htmlLink ?? null;
  }

  const updated: Visit = { ...current, id: visitId, start, end, attendees, label, calendarId, eventId, htmlLink, remote: patch.remote !== undefined ? patch.remote : current.remote };
  // Persist to the visit's own subtask (visit.id == subtask id): refresh its readable
  // description and its name (date/time may have changed).
  await zoho.setTaskDescription(env, projectId, visitId, visitSubtaskDescription(updated));
  try {
    // Refresh the name (date/time may have changed) AND rewrite the CLEAN-format round-trip
    // blob on the subtask's own wo_schedule field so the machine data stays in sync.
    await zoho.setTaskFields(env, projectId, visitId, {
      name: visitSubtaskName(updated),
      [visitsFieldName(env)]: visitFieldBlob(updated),
    });
  } catch (e) {
    console.warn("updateVisit: subtask name / wo_schedule update failed (non-fatal):", e);
  }
  const visits = [...existing.visits];
  visits[idx] = updated;
  await mirrorScheduleFields(env, projectId, actionTaskId, sortVisits(visits), existing.status, existing.woStatus, existing.statusTaskId);

  return getWorkOrder(env, actionTaskId);
}

/** Remove a visit: delete its calendar event (best-effort), then delete its subtask. */
export async function removeVisit(
  env: Env,
  actionTaskId: string,
  visitId: string
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;
  const target = existing.visits.find((v) => v.id === visitId);
  if (!target) return null;

  const projectId = existing.projectId;
  if (target.eventId) {
    // Best-effort: deleteEvent ignores 404/410 (already gone).
    await cal.deleteEvent(env, target.calendarId, target.eventId);
  }
  // Delete the visit subtask (visit.id == subtask id).
  await zoho.deleteTask(env, projectId, visitId);
  const visits = existing.visits.filter((v) => v.id !== visitId);
  await mirrorScheduleFields(env, projectId, actionTaskId, visits, existing.status, existing.woStatus, existing.statusTaskId);

  return getWorkOrder(env, actionTaskId);
}

//------------------------------------------------------------------------------
// RECONCILE (two-way calendar sync) — cron + POST /sync/calendar.
//
// Reads reschedules made directly on the calendar back onto the WO/Zoho task.
// The WO is the tie-breaker: if a WO edit and a calendar edit conflict, the WO
// wins (we re-push the WO's intended times to the event). Here, since the WO
// stores the event id but times are only mirrored, we treat a calendar change as
// authoritative for the *schedule* and simply record it — but we flag conflicts
// so a WO-side override can win. See README "Two-way sync model".
//------------------------------------------------------------------------------
export async function reconcileCalendar(env: Env): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, reconciled: 0, conflicts: 0, details: [] };

  // Look back a window a bit larger than the cron interval to avoid missing edits.
  const lookbackMs = 20 * 60 * 1000; // 20 min (cron runs every 10)
  const updatedMin = new Date(Date.now() - lookbackMs).toISOString();

  // Only the default calendar in the interim build; extend to per-WO calendars later.
  const events = await cal.listEvents(env, env.DEFAULT_CALENDAR_ID, { updatedMin });

  // Rate-limit relief (2026-09-03): the cron ran 144×/day and pulled EVERY work order from Zoho
  // (paginated /tasks) even when no calendar event had changed — pure background spend against
  // Zoho's 100-per-API-per-2-min budget. Nothing to reconcile → don't touch Zoho at all.
  if (events.length === 0) return result;

  // Build a WO index keyed by event id so we can match calendar changes to WOs.
  const wos = await listWorkOrders(env, { filter: "all", sort: "newest" });
  const byEventId = new Map<string, WorkOrder>();
  for (const wo of wos) {
    if (wo.schedule.eventId) byEventId.set(wo.schedule.eventId, wo);
  }

  for (const ev of events) {
    result.scanned++;
    const woNumber = ev.extendedProperties?.private?.fhiWoNumber;
    const wo = byEventId.get(ev.id) ?? wos.find((w) => w.workOrderNumber === woNumber);
    if (!wo) continue;

    const calStart = ev.start?.dateTime ?? null;
    const calEnd = ev.end?.dateTime ?? null;

    // Cancelled event -> nothing to mirror; note it.
    if (ev.status === "cancelled") {
      result.details.push({ workOrderNumber: wo.workOrderNumber, action: "event_cancelled" });
      continue;
    }

    // If the calendar times differ from what the WO has, mirror them onto the WO.
    // (In this interim model the WO doesn't independently store times, so the
    // calendar reschedule is accepted. When WO-side scheduling metadata is added,
    // compare timestamps and let the WO win on conflict — increment conflicts.)
    const changed = calStart !== wo.schedule.start || calEnd !== wo.schedule.end;
    if (changed) {
      // Nothing to write into Zoho for pure times in the interim (times live on the
      // event); record the reconcile so it's auditable. Hook Zoho date fields here
      // if/when they're added.
      result.reconciled++;
      result.details.push({ workOrderNumber: wo.workOrderNumber, action: "schedule_mirrored" });
    }
  }

  return result;
}

//------------------------------------------------------------------------------
// USED ITEMS (Feature A) — materials/parts logged against a WO, stored as raw
// JSON in the wo_used_items plain-text task custom field (stays with the WO).
//------------------------------------------------------------------------------

/** The configured used-items field name (default "wo_used_items"). */
function usedItemsFieldName(env: Env): string {
  return env.ZOHO_USED_ITEMS_FIELD || "wo_used_items";
}

/**
 * Parse the used-items list off a task. The value lives as a TOP-LEVEL custom
 * field on the raw task (action.raw?.[fieldName]) and is stored as raw JSON
 * (plain-text field, not the rich-text description). Tolerant: any parse error
 * (or empty) yields an empty list.
 */
export function usedItemsFromTask(env: Env, action: zoho.ZohoTask): UsedItem[] {
  const field = usedItemsFieldName(env);
  const raw = action?.raw?.[field];
  if (!raw || typeof raw !== "string") return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as unknown[]).map(normalizeUsedItem) : [];
  } catch {
    return [];
  }
}

/**
 * Fill in the used-item fields added by the "installed / billable" contract on items
 * stored before those fields existed, so GET /work-orders/:id always returns them:
 * installed (default false), source ("manual" unless the item carries a sourcePartId,
 * in which case "part"), and sourcePartId (default null). Tolerant of partial shapes.
 */
function normalizeUsedItem(raw: unknown): UsedItem {
  const r = (raw ?? {}) as Partial<UsedItem>;
  const sourcePartId = r.sourcePartId ?? null;
  const source: UsedItem["source"] =
    r.source === "part" || r.source === "manual" ? r.source : sourcePartId ? "part" : "manual";
  return {
    id: r.id ?? crypto.randomUUID(),
    item: r.item ?? "",
    quantity: r.quantity ?? null,
    note: r.note ?? null,
    at: r.at ?? new Date().toISOString(),
    by: r.by ?? null,
    installed: r.installed === true,
    source,
    sourcePartId,
  };
}

/** Add a used item to a WO: append, persist the JSON to the field, return the refreshed WO. */
export async function addUsedItem(
  env: Env,
  actionTaskId: string,
  input: AddUsedItemInput
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;

  const item: UsedItem = {
    id: crypto.randomUUID(),
    item: input.item,
    quantity: input.quantity ?? null,
    note: input.note ?? null,
    at: new Date().toISOString(),
    by: input.by ?? null,
    installed: false,      // manual adds default to not-yet-installed
    source: "manual",
    sourcePartId: null,
  };
  const list = [...existing.usedItems, item];
  const field = usedItemsFieldName(env);
  await zoho.setTaskFields(env, existing.projectId, actionTaskId, { [field]: JSON.stringify(list) });

  return getWorkOrder(env, actionTaskId);
}

/**
 * Patch one used item (installed / quantity / note) by id, persist, return the
 * refreshed WO. Returns null if the WO is missing; a WO with no matching item id
 * is written back unchanged (idempotent). Never touches id/source/sourcePartId.
 */
export async function patchUsedItem(
  env: Env,
  actionTaskId: string,
  itemId: string,
  patch: PatchUsedItemInput
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;

  const list = existing.usedItems.map((i) =>
    i.id === itemId
      ? {
          ...i,
          installed: patch.installed !== undefined ? patch.installed : i.installed,
          quantity: patch.quantity !== undefined ? patch.quantity : i.quantity,
          note: patch.note !== undefined ? patch.note : i.note,
        }
      : i
  );
  const field = usedItemsFieldName(env);
  await zoho.setTaskFields(env, existing.projectId, actionTaskId, { [field]: JSON.stringify(list) });

  return getWorkOrder(env, actionTaskId);
}

// RETIRED 2026-08-23: syncUsedItemFromPart — the interim "auto-create a used-item JSON
// row when a part is Installed" bridge. In the unified model the item IS the record
// (its status carries installed), so nothing writes the wo_used_items blob anymore.

/** Remove a used item by id: drop, persist, return the refreshed WO (null if WO missing). */
export async function removeUsedItem(
  env: Env,
  actionTaskId: string,
  itemId: string
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;

  const list = existing.usedItems.filter((i) => i.id !== itemId);
  const field = usedItemsFieldName(env);
  await zoho.setTaskFields(env, existing.projectId, actionTaskId, { [field]: JSON.stringify(list) });

  return getWorkOrder(env, actionTaskId);
}

//------------------------------------------------------------------------------
// LOG HOURS (Feature B) — self-managed hours log. Zoho Projects v3 has NO task
// time-log endpoint, so hours are OURS: F3 moved them from KV (`hours:<id>`) to
// Postgres hours_entries (repo/hours.ts). The WO still lives in Zoho, so writes
// pass a WoRef (ids/keys from the loaded WO) and the repo keeps a shadow
// work_orders row in step via external_ids.
//------------------------------------------------------------------------------

/** The repo's view of a loaded WO (what ensureWorkOrderRef needs). */
function woRefOf(wo: WorkOrder): WoRef {
  return {
    actionTaskId: wo.id,
    zohoProjectId: wo.projectId,
    projectKey: wo.projectKey,
    projectName: wo.projectName,
    client: wo.client,
    workOrderNumber: wo.workOrderNumber,
    subject: wo.subject,
  };
}

/**
 * Log hours against a WO: appends an hours_entries row (position = next index),
 * and returns the refreshed WO (whose hours getWorkOrder reads back from Postgres).
 */
export async function logHours(
  env: Env,
  actionTaskId: string,
  input: LogHoursInput
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;
  await hoursRepo.appendHoursEntry(env, woRefOf(existing), {
    tech: input.techEmail ?? null,
    hours: input.hours,
    at: input.date ?? null,
    note: input.note ?? null,
  });
  return getWorkOrder(env, actionTaskId);
}

/** Delete an item (a purchasing task). Returns true (idempotent — a missing task is fine). */
export async function deleteItem(env: Env, itemId: string): Promise<boolean> {
  await zoho.deletePurchaseTask(env, itemId);
  return true;
}

/** Delete one hours entry by index (positions re-packed). Null if out of range / no WO. */
export async function deleteHoursEntry(
  env: Env,
  actionTaskId: string,
  index: number
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;
  const hours = await hoursRepo.deleteHoursEntry(env, actionTaskId, index);
  if (!hours) return null;
  return getWorkOrder(env, actionTaskId);
}

/**
 * Edit one hours entry (by its index) — hours / note / tech. Returns the refreshed WO,
 * or null if the WO or index isn't found.
 */
export async function editHoursEntry(
  env: Env,
  actionTaskId: string,
  index: number,
  patch: { hours?: number; note?: string | null; tech?: string | null }
): Promise<WorkOrder | null> {
  const existing = await getWorkOrder(env, actionTaskId);
  if (!existing) return null;
  const hours = await hoursRepo.editHoursEntry(env, actionTaskId, index, patch);
  if (!hours) return null;
  return getWorkOrder(env, actionTaskId);
}

//------------------------------------------------------------------------------
// DAILY REPORTS — a tech appends dated notes to a WO over the day; "send" compiles
// the day's entries into a text PDF that the Worker serves, records a dated Zoho
// subtask, and posts a digest to Cliq. F3: entries, days, sent state and the PDF
// bytes live in Postgres (repo/daily-reports.ts: daily_reports / daily_report_entries
// / files) instead of KV. Zoho Projects v3 has no reliable task-attachment endpoint
// on our API base, so the PDF is served by this Worker; attaching to Zoho is
// best-effort only.
//------------------------------------------------------------------------------

/**
 * The WoRef for a daily-report write. The old KV path did not need the WO to be
 * loadable; with a real FK the WO must exist (data-model §8.10: unknown WO → 404),
 * so an unknown WO throws DailyReportError (→ 404 from the router).
 */
async function woRefForDailyReport(env: Env, actionTaskId: string): Promise<WoRef> {
  const known = await withTenantRead(env, tenantOf(env), (tx) => findWorkOrderRef(tx, actionTaskId));
  if (known) {
    // The shadow row exists; ensureWorkOrderRef short-circuits on the external id.
    return { actionTaskId, zohoProjectId: "", projectKey: "", projectName: "", workOrderNumber: "", subject: "" };
  }
  const wo = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!wo) throw new WorkOrderNotFound(actionTaskId);
  return woRefOf(wo);
}

/** Thrown by daily-report writes for an unknown WO (router → 404). */
export class WorkOrderNotFound extends Error {
  constructor(public readonly actionTaskId: string) {
    super("work order not found");
    this.name = "WorkOrderNotFound";
  }
}

/**
 * Append a daily-report entry for a WO (default day = today in ET). Returns the
 * updated day.
 */
export async function addDailyReportEntry(
  env: Env,
  actionTaskId: string,
  input: AddDailyReportEntryInput
): Promise<{ date: string; entries: DailyReportEntry[] }> {
  const ref = await woRefForDailyReport(env, actionTaskId);
  return dailyRepo.addEntry(env, ref, { text: input.text, tech: input.tech ?? null, date: input.date });
}

/**
 * Edit one daily-report entry (by index within its day) — the note text. Returns the
 * updated day, or null if the index is out of range. Day defaults to today (ET).
 */
export async function editDailyReportEntry(
  env: Env,
  actionTaskId: string,
  index: number,
  text: string,
  date?: string
): Promise<{ date: string; entries: DailyReportEntry[] } | null> {
  return dailyRepo.editEntry(env, actionTaskId, index, text, date);
}

/** Delete one daily-report entry by index within its day. Null if out of range. */
export async function deleteDailyReportEntry(
  env: Env,
  actionTaskId: string,
  index: number,
  date?: string
): Promise<{ date: string; entries: DailyReportEntry[] } | null> {
  return dailyRepo.deleteEntry(env, actionTaskId, index, date);
}

/** Get a day's report (entries + sent/pdfUrl). Default = today. */
export async function getDailyReport(
  env: Env,
  actionTaskId: string,
  date?: string
): Promise<DailyReportDay> {
  return dailyRepo.getDailyReport(env, actionTaskId, date);
}

/** List which days have reports for a WO. */
export async function listDailyReportDays(env: Env, actionTaskId: string): Promise<{ days: string[] }> {
  return dailyRepo.listDailyReportDays(env, actionTaskId);
}

/** GET …/daily-report/days rows ({date, entries:<count>, sent, pdfUrl}) in one query. */
export async function listDailyReportDaysEnriched(
  env: Env,
  actionTaskId: string
): Promise<Array<{ date: string; entries: number; sent: boolean; pdfUrl: string | null }>> {
  return dailyRepo.listDailyReportDaysEnriched(env, actionTaskId);
}

/**
 * Retrieve the compiled PDF bytes for a WO+date (null if none). Also returns the
 * WO number (for the download filename) when available.
 */
export async function getDailyReportPdf(
  env: Env,
  actionTaskId: string,
  date: string
): Promise<{ bytes: Uint8Array; woNumber: string | null } | null> {
  return dailyRepo.getPdf(env, actionTaskId, date);
}

/**
 * Compile the day's entries into a PDF, store it, record a best-effort Zoho subtask
 * under the WO's Daily Report task, post a Cliq digest, and mark the day sent.
 * Returns null if the WO can't be loaded (route -> 404); throws "no entries to
 * send" when the day is empty (route -> 400). Re-sending is allowed: the PDF and
 * sent state are overwritten, and a prior send never blocks a re-send.
 */
export async function sendDailyReport(
  env: Env,
  actionTaskId: string,
  date?: string
): Promise<DailyReportDay | null> {
  const wo = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!wo) return null;

  const day = date || todayET();
  const entries = (await dailyRepo.getDailyReport(env, actionTaskId, day)).entries;
  if (!entries.length) throw new Error("no entries to send");

  // Build the compiled report body (lines for the PDF; plain text for Zoho/Cliq).
  const { lines, text } = buildDailyReportContent(wo, day, entries);
  const pdf = buildDailyReportPdf(lines);

  // The PDF is served by THIS Worker, so the link must point back at it (PUBLIC_WORKER_URL).
  const pdfUrl = dailyRepo.pdfUrlFor(env, actionTaskId, day);

  // Store the PDF + mark sent FIRST (our own state), then the best-effort side effects.
  await dailyRepo.markSent(env, woRefOf(wo), day, pdf, pdfUrl);

  // Best-effort Zoho record: a dated subtask under the WO's Daily Report task, with
  // the compiled text (+ the PDF link) as its description. Non-fatal.
  if (wo.dailyReportTaskId) {
    try {
      const desc = pdfUrl ? `${text}\n\nPDF: ${pdfUrl}` : text;
      await zoho.createTask(env, wo.projectId, {
        name: `${DAILY_REPORT_TASK_NAME} — ${day}`,
        taskListId: wo.taskListId,
        description: desc,
        parentTaskId: wo.dailyReportTaskId,
      });
    } catch (e) {
      console.warn(`sendDailyReport: Zoho subtask create failed (non-fatal):`, e);
    }
  }

  // Best-effort Cliq post to the #dailyreports channel.
  const header = `📋 Daily Report — WO ${wo.workOrderNumber} (${wo.client}) — ${day}`;
  const msg = buildCliqReportMessage(header, text, pdfUrl);
  await postToCliq(env.CLIQ_DAILY_WEBHOOK, msg);

  return { date: day, entries, sent: true, pdfUrl };
}

/**
 * Compile ALL entries across ALL days for a WO into ONE cumulative PDF (per-day
 * section headers, entries in chronological order), store it on the cumulative
 * pseudo-day (report_date NULL), record a best-effort Zoho subtask, post a Cliq
 * digest, and mark it sent. Returns null if the WO can't be loaded (route -> 404);
 * throws "no entries to send" when NO day has entries (route -> 400). Re-sending is
 * allowed.
 */
export async function sendCumulativeReport(
  env: Env,
  actionTaskId: string
): Promise<DailyReportDay | null> {
  const wo = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!wo) return null;

  const perDay = await dailyRepo.entriesByDay(env, actionTaskId);
  const totalEntries = perDay.reduce((sum, d) => sum + d.entries.length, 0);
  if (!totalEntries) throw new Error("no entries to send");

  const through = todayET();
  const { lines, text } = buildCumulativeReportContent(wo, perDay, through);
  const pdf = buildDailyReportPdf(lines);
  const pdfUrl = dailyRepo.pdfUrlFor(env, actionTaskId, dailyRepo.CUMULATIVE);
  await dailyRepo.markSent(env, woRefOf(wo), dailyRepo.CUMULATIVE, pdf, pdfUrl);

  if (wo.dailyReportTaskId) {
    try {
      const desc = pdfUrl ? `${text}\n\nPDF: ${pdfUrl}` : text;
      await zoho.createTask(env, wo.projectId, {
        name: `${DAILY_REPORT_TASK_NAME} — Cumulative (through ${through})`,
        taskListId: wo.taskListId,
        description: desc,
        parentTaskId: wo.dailyReportTaskId,
      });
    } catch (e) {
      console.warn(`sendCumulativeReport: Zoho subtask create failed (non-fatal):`, e);
    }
  }

  const header = `📋 Daily Report — Cumulative — WO ${wo.workOrderNumber} (${wo.client}) through ${through}`;
  const msg = buildCliqReportMessage(header, text, pdfUrl);
  await postToCliq(env.CLIQ_DAILY_WEBHOOK, msg);

  // Return shape mirrors the single-day report; date="cumulative", entries flattened.
  const entries = perDay.flatMap((d) => d.entries);
  return { date: "cumulative", entries, sent: true, pdfUrl };
}

/**
 * Turn a WO + a day's entries into the compiled report body: `lines` feed the PDF
 * writer; `text` is the plain-text version for the Zoho subtask description + Cliq.
 */
function buildDailyReportContent(
  wo: WorkOrder,
  date: string,
  entries: DailyReportEntry[]
): { lines: string[]; text: string } {
  const lines: string[] = [];
  lines.push("FHI Florida — Daily Report");
  lines.push("");
  lines.push(`Work Order: ${wo.workOrderNumber || "(unnumbered)"}`);
  lines.push(`Client: ${wo.client}`);
  if (wo.siteAddress) lines.push(`Site: ${wo.siteAddress}`);
  lines.push(`Membership: ${wo.membershipLevel || "—"}`);
  if (wo.companyCamUrl) lines.push(`CompanyCam: ${wo.companyCamUrl}`);
  lines.push(`Date: ${formatDateET(date)}`);
  lines.push("");

  // Hours: the running total + each logged entry.
  lines.push(`Hours total: ${wo.hours.total}`);
  for (const h of wo.hours.entries) {
    const who = h.tech || "unassigned";
    const note = h.note ? ` — ${h.note}` : "";
    lines.push(`  - ${h.hours}h — ${who} (${formatDateET(h.at)})${note}`);
  }
  lines.push("");

  // Used items.
  lines.push("Used items:");
  if (wo.usedItems.length) {
    for (const u of wo.usedItems) {
      const qty = u.quantity != null ? ` x${u.quantity}` : "";
      const note = u.note ? ` — ${u.note}` : "";
      lines.push(`  - ${u.item}${qty}${note}`);
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");

  // The day's report entries (time, tech, text).
  lines.push("Report entries:");
  for (const e of entries) {
    const who = e.tech || "unknown";
    lines.push(`  [${formatDateTimeET(e.at)}] ${who}:`);
    for (const seg of (e.text || "").split(/\r?\n/)) lines.push(`    ${seg}`);
  }

  return { lines, text: lines.join("\n") };
}

/**
 * Turn a WO + ALL its days' entries into the cumulative report body. Same WO header /
 * hours / used-items block as the single-day report, then one section per day (in
 * chronological order) with a `formatDateET` heading and each entry timestamped via
 * `formatDateTimeET`. `lines` feed the PDF writer; `text` is the plain-text version
 * for the Zoho subtask description + Cliq.
 */
function buildCumulativeReportContent(
  wo: WorkOrder,
  perDay: Array<{ date: string; entries: DailyReportEntry[] }>,
  through: string
): { lines: string[]; text: string } {
  const lines: string[] = [];
  lines.push(`FHI Florida — Daily Report — Cumulative (through ${formatDateET(through)})`);
  lines.push("");
  lines.push(`Work Order: ${wo.workOrderNumber || "(unnumbered)"}`);
  lines.push(`Client: ${wo.client}`);
  if (wo.siteAddress) lines.push(`Site: ${wo.siteAddress}`);
  lines.push(`Membership: ${wo.membershipLevel || "—"}`);
  if (wo.companyCamUrl) lines.push(`CompanyCam: ${wo.companyCamUrl}`);
  lines.push("");

  // Hours: the running total + each logged entry (same as the single-day report).
  lines.push(`Hours total: ${wo.hours.total}`);
  for (const h of wo.hours.entries) {
    const who = h.tech || "unassigned";
    const note = h.note ? ` — ${h.note}` : "";
    lines.push(`  - ${h.hours}h — ${who} (${formatDateET(h.at)})${note}`);
  }
  lines.push("");

  // Used items (same as the single-day report).
  lines.push("Used items:");
  if (wo.usedItems.length) {
    for (const u of wo.usedItems) {
      const qty = u.quantity != null ? ` x${u.quantity}` : "";
      const note = u.note ? ` — ${u.note}` : "";
      lines.push(`  - ${u.item}${qty}${note}`);
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");

  // Per-day report sections, chronological, each with a date heading.
  lines.push("Report entries:");
  for (const d of perDay) {
    lines.push("");
    lines.push(`── ${formatDateET(d.date)} ──`);
    for (const e of d.entries) {
      const who = e.tech || "unknown";
      lines.push(`  [${formatDateTimeET(e.at)}] ${who}:`);
      for (const seg of (e.text || "").split(/\r?\n/)) lines.push(`    ${seg}`);
    }
  }

  return { lines, text: lines.join("\n") };
}

/**
 * Compose the Cliq channel message for a report: a short header line, the full
 * plain-text report body embedded inline (capped so a Cliq message can't blow up),
 * and a final `View PDF: <url>` line when a PDF url is available. Reuses the same
 * plain-text `text` the report already built for the Zoho subtask — no separate
 * formatting. Body cap ~3500 chars; longer bodies are truncated with a pointer to
 * the PDF for the full content (mainly protects the cumulative report).
 */
const CLIQ_BODY_CAP = 3500;
function buildCliqReportMessage(header: string, body: string, pdfUrl: string | null): string {
  let embedded = body;
  if (embedded.length > CLIQ_BODY_CAP) {
    embedded = embedded.slice(0, CLIQ_BODY_CAP) + "\n… (truncated — see PDF)";
  }
  let msg = `${header}\n\n${embedded}`;
  if (pdfUrl) msg += `\n\nView PDF: ${pdfUrl}`;
  return msg;
}

//------------------------------------------------------------------------------
// WORK-ORDER SUMMARY PDF — one comprehensive, human-readable PDF for a WO: info,
// notes, hours (grouped per person), parts used, and parts requested. Served raw
// by the Worker (same rationale as daily reports: no reliable Zoho attachment
// endpoint on our API base). Reuses the shared plain-text PDF writer (pdf.ts).
//------------------------------------------------------------------------------

/**
 * Gather everything for a work order and render a single comprehensive summary
 * PDF. Returns null when the WO can't be loaded (route -> 404). Best-effort on
 * the purchasing lookup: a purchasing hiccup yields an empty "parts requested"
 * section rather than failing the whole PDF.
 */
export async function buildWorkOrderSummary(
  env: Env,
  actionTaskId: string
): Promise<Uint8Array | null> {
  const wo = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!wo) return null;

  // Parts requested FROM this WO: purchasing rows whose src-wo-id is this WO's
  // actionTaskId (wo.id). Best-effort — never fail the summary over purchasing.
  let requested: PurchaseItem[] = [];
  try {
    const all = await listPurchasing(env);
    requested = all.filter((p) => p.sourceWoId === wo.id);
  } catch (e) {
    console.warn("buildWorkOrderSummary: listPurchasing failed (non-fatal):", e);
  }

  const lines = buildWorkOrderSummaryContent(wo, requested);
  return buildTextPdf(lines);
}

/** Build the summary PDF body (a `string[]` of lines) from a WO + its requested parts. */
function buildWorkOrderSummaryContent(wo: WorkOrder, requested: PurchaseItem[]): string[] {
  const lines: string[] = [];
  lines.push("FHI Florida — Work Order Summary");
  lines.push("");

  // 1) Work order info.
  lines.push("Work Order Info");
  lines.push(`Work Order: ${wo.workOrderNumber || "(unnumbered)"}`);
  lines.push(`Created: ${wo.createdAt ? formatDateET(wo.createdAt) : "—"}`);
  lines.push(`Client: ${wo.client}`);
  lines.push(`Site: ${wo.siteAddress || "—"}`);
  lines.push(`Membership: ${wo.membershipLevel || "—"}`);
  lines.push(`Subject: ${wo.subject}`);
  lines.push(`Status: ${wo.status} / ${wo.scheduleStatus}`);
  lines.push(`Priority: ${wo.priority || "—"}`);
  if (wo.companyCamUrl) lines.push(`CompanyCam: ${wo.companyCamUrl}`);
  lines.push("");

  // 2) Notes / Work Performed — the human notes only. getWorkOrder already strips
  // the "Scheduled Visits" section and the fhi-visits-v1 token via cleanNotes(), so
  // wo.notes is exactly the technician-entered text.
  lines.push("Notes / Work Performed");
  if (wo.notes && wo.notes.trim()) {
    for (const seg of wo.notes.split(/\r?\n/)) lines.push(seg);
  } else {
    lines.push("None recorded.");
  }
  lines.push("");

  // 3) Hours — grouped per person (tech email, or "Unassigned" when null), each
  // person's entries then their subtotal, closed by the grand total.
  lines.push("Hours");
  if (wo.hours.entries.length) {
    const groups = new Map<string, Array<{ hours: number; at: string; note: string | null }>>();
    for (const e of wo.hours.entries) {
      const who = e.tech || "Unassigned";
      const arr = groups.get(who) ?? [];
      arr.push({ hours: e.hours, at: e.at, note: e.note });
      groups.set(who, arr);
    }
    for (const [who, entries] of groups) {
      lines.push(`${who}:`);
      let subtotal = 0;
      for (const en of entries) {
        subtotal += en.hours;
        const note = en.note ? ` — ${en.note}` : "";
        lines.push(`  ${formatDateET(en.at)} — ${en.hours} hr${note}`);
      }
      lines.push(`  Subtotal: ${round2(subtotal)} hr`);
    }
  } else {
    lines.push("None recorded.");
  }
  lines.push(`Grand total: ${wo.hours.total} hr`);
  lines.push("");

  // 4) Parts used (qty may be null -> omit the "×").
  lines.push("Parts Used");
  if (wo.usedItems.length) {
    for (const u of wo.usedItems) {
      const qty = u.quantity != null ? `${u.quantity}× ` : "";
      const note = u.note ? ` — ${u.note}` : "";
      lines.push(`${qty}${u.item}${note}`);
    }
  } else {
    lines.push("None recorded.");
  }
  lines.push("");

  // 5) Parts requested (from the purchasing dashboard, filtered to this WO).
  lines.push("Parts Requested");
  if (requested.length) {
    for (const p of requested) {
      const qty = p.quantity != null ? `${p.quantity}× ` : "";
      const note = p.note ? ` — ${p.note}` : "";
      lines.push(`${qty}${p.item} — ${p.status}${note}`);
    }
  } else {
    lines.push("None requested.");
  }

  return lines;
}

/** Round to 2 decimals (per-person hour subtotals). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

//------------------------------------------------------------------------------
// INVOICE-NOTES RAW MATERIAL — assemble EVERYTHING on a work order into one
// labeled block for the house-style invoice-notes AI. Craig's tech notes live in
// the DAILY REPORTS (plus notes/hours/parts), so the AI must see the whole WO, not
// just wo.notes. Sections with no data are skipped. Used by POST
// /work-orders/:id/invoice-notes (index.ts calls this, then generateInvoiceNotes).
//------------------------------------------------------------------------------

/**
 * Gather the whole work order into a single model-facing raw-material string:
 * header info, notes, visits, hours, used items, requested parts, and daily-report
 * entries across ALL days (reusing the same days-index gathering the cumulative
 * report uses — the main source of tech notes). Returns null when the WO can't be
 * loaded (route -> 404). `hasContent` is false ONLY when every substantive source
 * is empty (notes, daily-report entries, hours, used items, requested parts) — the
 * route uses it to decide the "nothing to summarize" 400.
 */
export async function buildInvoiceNotesMaterial(
  env: Env,
  actionTaskId: string
): Promise<{ wo: WorkOrder; material: string; hasContent: boolean } | null> {
  const wo = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!wo) return null;

  // Parts requested FROM this WO (best-effort — a purchasing hiccup must not fail
  // invoice-notes; it just yields an empty requested-parts section).
  let requested: PurchaseItem[] = [];
  try {
    const all = await listPurchasing(env);
    requested = all.filter((p) => p.sourceWoId === wo.id);
  } catch (e) {
    console.warn("buildInvoiceNotesMaterial: listPurchasing failed (non-fatal):", e);
  }

  // Daily-report entries across ALL days — same gathering the cumulative report
  // uses (days index -> each day's entries). THIS is the main source of tech notes.
  const perDay: Array<{ date: string; entries: DailyReportEntry[] }> = await dailyRepo.entriesByDay(env, actionTaskId);
  const dailyEntryCount = perDay.reduce((sum, d) => sum + d.entries.length, 0);

  const hasNotes = !!(wo.notes && wo.notes.trim());
  const hasContent =
    hasNotes ||
    dailyEntryCount > 0 ||
    wo.hours.entries.length > 0 ||
    wo.usedItems.length > 0 ||
    requested.length > 0;

  const lines: string[] = [];

  // Work-order info (labeled for the model; header alone does NOT count as content).
  lines.push("Work Order Information:");
  if (wo.workOrderNumber) lines.push(`- WO number: ${wo.workOrderNumber}`);
  if (wo.client) lines.push(`- Client: ${wo.client}`);
  if (wo.siteAddress) lines.push(`- Site address: ${wo.siteAddress}`);
  if (wo.membershipLevel) lines.push(`- Membership level: ${wo.membershipLevel}`);
  if (wo.companyCamUrl) lines.push(`- CompanyCam: ${wo.companyCamUrl}`);
  if (wo.priority) lines.push(`- Priority: ${wo.priority}`);
  if (wo.createdAt) lines.push(`- Created: ${formatDateET(wo.createdAt)}`);

  // Notes (the Action task description).
  if (hasNotes) {
    lines.push("");
    lines.push("Notes:");
    lines.push((wo.notes as string).trim());
  }

  // Visits (date + techs).
  if (wo.visits.length) {
    lines.push("");
    lines.push("Visits:");
    for (const v of wo.visits) {
      const when = v.start ? formatDateET(v.start) : "unscheduled";
      const who = v.attendees.length ? v.attendees.join(", ") : "unassigned";
      lines.push(`- ${when} — ${who}`);
    }
  }

  // Hours (tech, date, hours, note).
  if (wo.hours.entries.length) {
    lines.push("");
    lines.push("Hours:");
    for (const h of wo.hours.entries) {
      const who = h.tech || "unassigned";
      const note = h.note ? ` — ${h.note}` : "";
      lines.push(`- ${h.hours}h — ${who} (${formatDateET(h.at)})${note}`);
    }
  }

  // Used items (parts used).
  if (wo.usedItems.length) {
    lines.push("");
    lines.push("Parts used:");
    for (const u of wo.usedItems) {
      const qty = u.quantity != null ? ` x${u.quantity}` : "";
      const note = u.note ? ` — ${u.note}` : "";
      lines.push(`- ${u.item}${qty}${note}`);
    }
  }

  // Requested parts (item, qty, status, note).
  if (requested.length) {
    lines.push("");
    lines.push("Requested parts:");
    for (const p of requested) {
      const qty = p.quantity != null ? ` x${p.quantity}` : "";
      const note = p.note ? ` — ${p.note}` : "";
      lines.push(`- ${p.item}${qty} — ${p.status}${note}`);
    }
  }

  // Daily report entries across ALL days (the main source of tech notes).
  if (perDay.length) {
    lines.push("");
    lines.push("Daily report entries:");
    for (const d of perDay) {
      lines.push(`${formatDateET(d.date)}:`);
      for (const e of d.entries) {
        const who = e.tech || "unknown";
        const text = (e.text || "").trim();
        lines.push(`  - [${formatDateTimeET(e.at)}] ${who}: ${text}`);
      }
    }
  }

  return { wo, material: lines.join("\n"), hasContent };
}

//------------------------------------------------------------------------------
// PURCHASING (parts request -> purchasing dashboard). A part requested from a WO
// becomes a task in the FHI-907 purchasing project. The task reuses work_order_hash
// to point back to the SOURCE WO#, stores the source WO's actionTaskId in a machine
// trailer in the description (so the UI can deep-link), and posts to Cliq.
//------------------------------------------------------------------------------

// DEFAULT_ORDER_STATUS ("Needed") is imported from config so the value is shared
// with zoho.createPurchaseTask (the write side) — one source of truth. There is
// deliberately NO local whitelist of order_status values here anymore: Zoho is the
// authoritative validator of its own pick-list, so whatever it returns is passed
// straight through (Craig has renamed these labels twice; a local list was fragile).

// Machine trailer in the purchase-task description linking back to the source WO's
// actionTaskId. base-[A-Za-z0-9] ids so a simple bracket token is safe + sanitizer-proof.
const SRC_WO_ID_RE = /\[src-wo-id:([^\]]+)\]/;
// The "Qty: N" line written into the purchase-task description.
const QTY_LINE_RE = /Qty:\s*(\d+(?:\.\d+)?)/i;

/** Parse the "[src-wo-id:<id>]" machine trailer from a purchase-task description. */
function parseSrcWoId(desc: string): string | null {
  const m = htmlToText(desc).match(SRC_WO_ID_RE);
  return m ? m[1].trim() : null;
}

/** Parse the "Qty: N" line from a purchase-task description (null if absent/invalid). */
function parsePurchaseQty(desc: string): number | null {
  const m = htmlToText(desc).match(QTY_LINE_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** The user-facing note: strip the src-wo-id trailer and the Qty line. */
function cleanPurchaseNote(desc: string): string | null {
  const text = htmlToText(desc).replace(SRC_WO_ID_RE, "").replace(QTY_LINE_RE, "").trim();
  return text || null;
}

/**
 * Build a purchase-task description from its parts, in a stable order:
 *   <note>\n[src-wo-id:<id>]\nQty: <n>
 * Parsing is order-independent, but a stable writer keeps re-reads idempotent.
 */
function buildPurchaseDescription(note: string | null, srcWoId: string | null, quantity: number | null): string {
  const parts: string[] = [];
  if (note && note.trim()) parts.push(note.trim());
  if (srcWoId) parts.push(`[src-wo-id:${srcWoId}]`);
  if (quantity !== null && quantity !== undefined) parts.push(`Qty: ${quantity}`);
  return parts.join("\n");
}

/** Map a purchasing task -> the PurchaseItem shape the dashboard consumes. */
function purchaseItemFromTask(env: Env, task: zoho.ZohoTask, sourceWoIdOverride: string | null): PurchaseItem {
  // Read the order_status value for DISPLAY (orderStatusRaw reads .raw then the flattened
  // customFields map, trimmed). This is presence-for-display only — it is NOT the item
  // discriminator anymore (that's the [src-wo-id:] trailer; see isItemSubtask). Pass through
  // whatever Zoho returns; fall back to the default only when the field is missing/blank.
  // TODO(craig): the per-project task endpoint sometimes omits custom fields; if the
  // status/sourceWo come back blank on the live portal, hydrate purchasing rows via
  // the portal-wide filter query keyed on the project id instead of getTasksByProject.
  const status = orderStatusRaw(env, task) || DEFAULT_ORDER_STATUS;

  const sourceWo =
    task.workOrderHash ?? (task.raw?.work_order_hash as string | undefined) ?? task.customFields[woFieldName(env)] ?? null;

  const desc = task.description ?? "";
  // Archived === the item reached a DONE status (Installed / Not Needed / Cancelled).
  // Derived from the order_status DONE set (config.orderDoneStatuses), NOT solely from
  // the Zoho task's completed flag: setTaskCompleted uses the SERVICE-project closed-
  // status id (ZOHO_STATUS_CLOSED_ID), which is invalid for the FHI-907 PURCHASING
  // project, so that best-effort completion write does not reliably close purchasing
  // tasks. Status-membership is deterministic and un-archives automatically when the
  // status moves back to a pending value. We still OR in task.isCompleted so a task
  // completed directly in Zoho also reads as archived.
  const doneSet = orderDoneStatuses(env).map((s) => s.trim().toLowerCase());
  const statusIsDone = doneSet.includes((status ?? "").trim().toLowerCase());
  return {
    id: task.id,
    item: task.name,
    quantity: parsePurchaseQty(desc),
    note: cleanPurchaseNote(desc),
    status,
    sourceWo,
    sourceWoId: sourceWoIdOverride ?? parseSrcWoId(desc),
    archived: task.isCompleted || statusIsDone,
    createdAt: task.createdAt ?? task.createdTime ?? null,
  };
}

// Per-WO "Items" container task. Each material/part is a subtask under it in the WO's
// OWN task list (SERVICE project) — parallel to the "Schedule" task for visits. No global
// purchasing project. Item subtasks carry the order_status field (the 7 statuses), so
// they're legible in Zoho AND findable by a portal-wide subtask query for the dashboard.
const ITEMS_TASK_NAME = "Items";

/** The order_status value on a task (raw custom field), trimmed; "" when absent. */
function orderStatusRaw(env: Env, task: zoho.ZohoTask): string {
  const f = orderStatusFieldName(env);
  const raw = (task?.raw?.[f] ?? task?.customFields?.[f]) as unknown;
  return typeof raw === "string" ? raw.trim() : "";
}
/**
 * An ITEM subtask is identified by the DURABLE `[src-wo-id:` trailer buildPurchaseDescription
 * writes — NOT by order_status presence (that pick-list now has a DEFAULT value on EVERY task,
 * so presence matches Action/Billing/visit tasks too). Guard against double-counting: a task
 * carrying a visit marker or the todo token is NOT an item, even if it also has the trailer.
 * Classification order is visit -> todo -> item, so those two win.
 */
function isItemSubtask(env: Env, task: zoho.ZohoTask): boolean {
  if (isVisitSubtask(env, task) || isTodoSubtask(env, task)) return false;
  return SRC_WO_ID_RE.test(htmlToText(task.description ?? ""));
}

/** Find the WO's "Items" container task (in its task list); create it if missing. Returns its id. */
async function ensureItemsTask(env: Env, projectId: string, taskListId: string): Promise<string> {
  const tasks = await zoho.getTasksByProject(env, projectId);
  const existing = tasks.find((t) => t.taskListId === taskListId && t.name === ITEMS_TASK_NAME);
  if (existing) return existing.id;
  const created = await zoho.createTask(env, projectId, { name: ITEMS_TASK_NAME, taskListId });
  return created.id;
}

/**
 * Add an ITEM to a work order. An Item is a SUBTASK under the WO's "Items" task (in the
 * WO's own task list), carrying order_status + a src-wo-id trailer + work_order_hash.
 * `status` sets the initial order_status (default "Needed"); a tech logging something used
 * off the truck passes e.g. "Installed (From Stock)". A Cliq materials post fires ONLY when
 * the item still needs sourcing (active status). Returns the created Item.
 */
export async function addItem(
  env: Env,
  actionTaskId: string,
  input: { item: string; quantity?: number; note?: string; status?: string }
): Promise<PurchaseItem | null> {
  const wo = await getWorkOrder(env, actionTaskId);
  if (!wo) return null;

  const itemsTaskId = await ensureItemsTask(env, wo.projectId, wo.taskListId);
  const status = input.status?.trim() || DEFAULT_ORDER_STATUS;
  const baseNote = input.note?.trim() ? input.note.trim() : null;
  const description = buildPurchaseDescription(baseNote, actionTaskId, input.quantity ?? null);

  const task = await zoho.createTask(env, wo.projectId, {
    name: input.item,
    taskListId: wo.taskListId,
    description,
    parentTaskId: itemsTaskId,
  });

  // Set order_status + work_order_hash on the subtask (best-effort; re-read for response).
  try {
    await zoho.setTaskFields(env, wo.projectId, task.id, {
      [orderStatusFieldName(env)]: status,
      [woFieldName(env)]: wo.workOrderNumber,
    });
  } catch (e) {
    console.warn("addItem: setTaskFields (order_status / work_order_hash) failed (non-fatal):", e);
  }

  // Cliq materials post only when the item still needs sourcing (not terminal/installed).
  const done = orderDoneStatuses(env).map((s) => s.trim().toLowerCase());
  if (!done.includes(status.toLowerCase())) {
    const qty = input.quantity ?? 1;
    const noteSuffix = baseNote ? ` — ${baseNote}` : "";
    const msg = `🧰 Item requested: ${input.item} x${qty} — WO ${wo.workOrderNumber} (${wo.client}, ${wo.siteAddress ?? ""})${noteSuffix}`;
    await postToCliq(env.CLIQ_MATERIALS_WEBHOOK, msg);
  }

  // S11: mirror the requested item onto the WO's "Materials" list, marked as from an Item
  // Request event (so the field crew sees it alongside manually-added materials). Best-effort.
  try {
    const qty = input.quantity ?? null;
    await createMaterialForWo(env, wo, {
      name: input.item,
      notes: baseNote,
      fromRequest: true,
      sourceItem: `${input.item}${qty ? ` ×${qty}` : ""}`,
      sourceItemId: task.id,
    });
  } catch (e) {
    console.warn("addItem: Materials mirror failed (non-fatal):", e);
  }

  // Re-read so the returned Item reflects order_status; fall back to a patched copy.
  const refreshed = await zoho.getTask(env, wo.projectId, task.id).catch(() => null);
  const t: zoho.ZohoTask = refreshed ?? {
    ...task,
    raw: { ...(task.raw ?? {}), [orderStatusFieldName(env)]: status, [woFieldName(env)]: wo.workOrderNumber },
  };
  return purchaseItemFromTask(env, t, actionTaskId);
}

/** Back-compat alias: request a part == add an item (default status "Needed"). */
export async function requestItem(
  env: Env,
  actionTaskId: string,
  input: RequestItemInput
): Promise<PurchaseItem | null> {
  return addItem(env, actionTaskId, { item: input.item, quantity: input.quantity, note: input.note });
}

/**
 * List all ITEMS for one work order — the item subtasks whose src-wo-id trailer points at
 * this WO, in ANY status (active + terminal). The WO's "Items" section: requested and used
 * together, filtered by status client-side. Ordered by createdAt.
 */
export async function listItemsForWo(env: Env, actionTaskId: string): Promise<PurchaseItem[]> {
  // Reuse the dashboard query (proven work_order_hash portal filter), then keep this WO's items.
  const all = await listPurchasing(env, undefined, true);
  return all
    .filter((p) => p.sourceWoId === actionTaskId)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

//------------------------------------------------------------------------------
// MATERIALS (S11) — a "Materials" holder task per WO; each subtask is a material.
// Added manually, or auto-mirrored from an Item Request (fromRequest). Identity is by the
// durable `fhi-material-v1:` token in the description (robust vs. the portal filter dropping
// parent ids), mirroring the To-Dos pattern.
//------------------------------------------------------------------------------
const MATERIAL_TOKEN_RE = /fhi-material-v1:([A-Za-z0-9_-]+)/;
interface MaterialTokenPayload {
  workOrderId: string | null;
  fromRequest: boolean;
  sourceItem: string | null;
  sourceItemId: string | null;
}
function isMaterialSubtask(task: zoho.ZohoTask): boolean {
  return MATERIAL_TOKEN_RE.test(htmlToText(task.description ?? ""));
}
function parseMaterialToken(desc: string): MaterialTokenPayload {
  const m = htmlToText(desc).match(MATERIAL_TOKEN_RE);
  if (m) {
    try {
      const o = JSON.parse(b64urlDecode(m[1])) as Partial<MaterialTokenPayload>;
      return {
        workOrderId: typeof o.workOrderId === "string" && o.workOrderId.trim() ? o.workOrderId : null,
        fromRequest: o.fromRequest === true,
        sourceItem: typeof o.sourceItem === "string" && o.sourceItem.trim() ? o.sourceItem : null,
        sourceItemId: typeof o.sourceItemId === "string" && o.sourceItemId.trim() ? o.sourceItemId : null,
      };
    } catch {
      /* fall through */
    }
  }
  return { workOrderId: null, fromRequest: false, sourceItem: null, sourceItemId: null };
}
function cleanMaterialNotes(desc: string): string {
  return htmlToText(desc)
    .replace(MATERIAL_TOKEN_RE, "")
    .replace(/^\s*From Item Request:.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function buildMaterialDescription(
  notes: string | null,
  workOrderId: string | null,
  fromRequest: boolean,
  sourceItem: string | null,
  sourceItemId: string | null
): string {
  const payload: MaterialTokenPayload = {
    workOrderId: workOrderId ?? null,
    fromRequest: !!fromRequest,
    sourceItem: sourceItem ?? null,
    sourceItemId: sourceItemId ?? null,
  };
  const token = `fhi-material-v1:${b64urlEncode(JSON.stringify(payload))}`;
  const parts: string[] = [];
  if (notes && notes.trim()) parts.push(notes.trim());
  if (fromRequest && sourceItem) parts.push(`From Item Request: ${sourceItem}`);
  parts.push(token);
  return parts.join("\n");
}
function materialFromTask(task: zoho.ZohoTask, woOverride: string | null): Material {
  const tok = parseMaterialToken(task.description ?? "");
  return {
    id: task.id,
    name: task.name,
    notes: cleanMaterialNotes(task.description ?? "") || null,
    fromRequest: tok.fromRequest,
    sourceItem: tok.sourceItem,
    sourceItemId: tok.sourceItemId,
    completed: task.isCompleted,
    workOrderId: woOverride ?? tok.workOrderId ?? "",
    createdAt: task.createdAt ?? task.createdTime ?? null,
    updatedAt: task.updatedAt ?? task.lastModifiedTime ?? null,
  };
}
/** Find the WO's "Materials" holder task (in its task list); create it if missing. */
async function ensureMaterialsTask(env: Env, projectId: string, taskListId: string): Promise<string> {
  const tasks = await zoho.getTasksByProject(env, projectId);
  const existing = tasks.find((t) => t.taskListId === taskListId && t.name === MATERIALS_TASK_NAME);
  if (existing) return existing.id;
  const created = await zoho.createTask(env, projectId, { name: MATERIALS_TASK_NAME, taskListId });
  return created.id;
}
/** Create a material subtask given an already-fetched WO (shared by manual add + the request hook). */
async function createMaterialForWo(
  env: Env,
  wo: WorkOrder,
  input: {
    name: string;
    notes?: string | null;
    fromRequest?: boolean;
    sourceItem?: string | null;
    sourceItemId?: string | null;
  }
): Promise<Material> {
  const holderId = await ensureMaterialsTask(env, wo.projectId, wo.taskListId);
  const description = buildMaterialDescription(
    input.notes ?? null,
    wo.id,
    input.fromRequest ?? false,
    input.sourceItem ?? null,
    input.sourceItemId ?? null
  );
  const task = await zoho.createTask(env, wo.projectId, {
    name: input.name,
    taskListId: wo.taskListId,
    description,
    parentTaskId: holderId,
  });
  // The work_order_hash stamp is what makes the material FINDABLE (listMaterialsForWo reads the
  // work_order_hash portal filter). A silently-failed stamp = an invisible row, so retry once and
  // then fail loudly, removing the orphan subtask so Zoho isn't left with a ghost.
  try {
    try {
      await zoho.setTaskFields(env, wo.projectId, task.id, { [woFieldName(env)]: wo.workOrderNumber });
    } catch (e1) {
      if (e1 instanceof ZohoThrottleError) throw e1;
      console.warn("createMaterialForWo: setTaskFields (work_order_hash) failed once, retrying:", e1);
      await zoho.setTaskFields(env, wo.projectId, task.id, { [woFieldName(env)]: wo.workOrderNumber });
    }
  } catch (e) {
    await zoho.deleteTask(env, wo.projectId, task.id).catch(() => undefined);
    throw new Error("Material was not saved: could not tag it to this work order (" + (e instanceof Error ? e.message : String(e)) + ")");
  }
  const refreshed = await zoho.getTask(env, wo.projectId, task.id).catch(() => null);
  return materialFromTask(refreshed ?? task, wo.id);
}
/** Add a material to a WO (manual). Returns the created Material, or null if the WO is gone. */
export async function addMaterial(
  env: Env,
  actionTaskId: string,
  input: CreateMaterialInput
): Promise<Material | null> {
  const wo = await getWorkOrder(env, actionTaskId, { allowCached: true });
  if (!wo) return null;
  return createMaterialForWo(env, wo, {
    name: input.name,
    notes: input.notes ?? null,
    fromRequest: false,
    sourceItem: null,
  });
}
/** List a WO's materials (its Materials-holder subtasks), oldest first. */
export async function listMaterialsForWo(env: Env, actionTaskId: string, _knownProjectId?: string | null): Promise<Material[]> {
  // FIX (2026-09-12, "added material never shows"): materials are SUBTASKS, and the per-project
  // /tasks listing (getTasksByProject) returns TOP-LEVEL tasks only — so every material was
  // invisible right after Add. Use the proven work_order_hash portal filter (cached; the router
  // invalidates it on every write), exactly like listPurchasing / listAllTodos, then keep this
  // WO's rows by the token's workOrderId. `_knownProjectId` is accepted for API compatibility
  // (the page still sends ?projectId=) but no longer needed.
  const tasks = await listWoTaggedTasks(env);
  return tasks
    .filter((t) => isMaterialSubtask(t))
    .map((t) => materialFromTask(t, null))
    .filter((m) => m.workOrderId === actionTaskId)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}
/** Update a material (currently: complete/reopen). Returns the refreshed Material. */
export async function updateMaterial(
  env: Env,
  actionTaskId: string,
  materialId: string,
  patch: UpdateMaterialInput
): Promise<Material | null> {
  const wo = await getWorkOrder(env, actionTaskId);
  if (!wo) return null;
  if (typeof patch.completed === "boolean") {
    try {
      await zoho.setTaskCompleted(env, wo.projectId, materialId, patch.completed);
    } catch (e) {
      console.warn("updateMaterial: setTaskCompleted failed (non-fatal):", e);
    }
  }
  const refreshed = await zoho.getTask(env, wo.projectId, materialId).catch(() => null);
  return refreshed ? materialFromTask(refreshed, actionTaskId) : null;
}
/** Delete a material subtask. Returns false only when the WO itself is gone. */
export async function deleteMaterial(env: Env, actionTaskId: string, materialId: string): Promise<boolean> {
  const wo = await getWorkOrder(env, actionTaskId);
  if (!wo) return false;
  await zoho.deleteTask(env, wo.projectId, materialId);
  return true;
}

/**
 * The unified Items dashboard across ALL work orders (purchasing's view). Uses the PROVEN
 * work_order_hash portal filter (contains "-WO-") — the earlier has_parents/getPortalSubtasks
 * approach did NOT return subtasks live (2026-08-23 dashboard bug). Item subtasks carry
 * work_order_hash (tagged on add), so the filter returns them; we keep the ones with an
 * order_status (that's what makes a task an item, vs Action/Billing/visit tasks). By DEFAULT
 * archived items (terminal: the two Installed + Canceled) are EXCLUDED; includeArchived=true
 * returns all. Optional status filter applied either way (case-insensitive exact match).
 */
export async function listPurchasing(
  env: Env,
  statusFilter?: string,
  includeArchived = false
): Promise<PurchaseItem[]> {
  const tasks = await listWoTaggedTasks(env);
  let items = tasks.filter((t) => isItemSubtask(env, t)).map((t) => purchaseItemFromTask(env, t, null));
  if (!includeArchived) items = items.filter((i) => i.archived !== true);
  const needle = (statusFilter ?? "").trim().toLowerCase();
  return needle ? items.filter((i) => (i.status ?? "").trim().toLowerCase() === needle) : items;
}

/**
 * Update an item (status / note / quantity). The item is a subtask in its WO's SERVICE
 * project; we locate it by id (portal filter) to get that project, then write. Archiving
 * is DERIVED from order_status (purchaseItemFromTask), so the setTaskCompleted call is a
 * best-effort Zoho-UI nicety (valid service-project status ids). Returns the refreshed Item,
 * or null if the id isn't found.
 */
export async function updatePurchase(
  env: Env,
  taskId: string,
  patch: UpdatePurchaseInput
): Promise<PurchaseItem | null> {
  const found = await zoho.listPortalTasksByFilter(
    env,
    JSON.stringify({ criteria: [{ field_name: "id", criteria_condition: "is", value: [taskId] }], pattern: "1" })
  );
  const current = found[0];
  if (!current || !current.projectId) return null;
  const projectId = current.projectId;

  if (patch.status) {
    const done = orderDoneStatuses(env).map((s) => s.trim().toLowerCase());
    const isDone = done.includes(patch.status.trim().toLowerCase());
    // REOPEN BEFORE WRITE (fixes "can't switch a Canceled item back to Install"): a Canceled
    // or Installed item's subtask is CLOSED, and Zoho can reject a field write on a completed
    // task — so when moving to a NON-done status we un-complete FIRST, then write order_status,
    // so the change actually lands instead of silently no-op'ing. For a DONE target we write
    // then close (below), preserving the prior behavior.
    if (!isDone) {
      try {
        await zoho.setTaskCompleted(env, projectId, taskId, false);
      } catch (e) {
        console.warn("updatePurchase: pre-reopen (setTaskCompleted false) failed (non-fatal):", e);
      }
    }
    try {
      await zoho.setTaskFields(env, projectId, taskId, { [orderStatusFieldName(env)]: patch.status });
    } catch (e) {
      console.warn("updatePurchase: order_status write failed (non-fatal):", e);
    }
    // Close it if the new status is a DONE one (the reopen above already handled non-done).
    if (isDone) {
      try {
        await zoho.setTaskCompleted(env, projectId, taskId, true);
      } catch (e) {
        console.warn("updatePurchase: complete (setTaskCompleted true) failed (non-fatal):", e);
      }
    }
  }

  // A note or quantity change rewrites the description, preserving the src-wo-id trailer.
  if (patch.note !== undefined || patch.quantity !== undefined) {
    const desc = current.description ?? "";
    const srcWoId = parseSrcWoId(desc);
    const newNote = patch.note !== undefined ? patch.note : cleanPurchaseNote(desc);
    const newQty = patch.quantity !== undefined ? patch.quantity : parsePurchaseQty(desc);
    await zoho.setTaskDescription(env, projectId, taskId, buildPurchaseDescription(newNote, srcWoId, newQty));
  }

  const refreshed = await zoho.getTask(env, projectId, taskId).catch(() => null);
  return refreshed ? purchaseItemFromTask(env, refreshed, null) : null;
}

//------------------------------------------------------------------------------
// TO-DOS / ACTION ITEMS. Every WO has a "To-Dos" task (auto-created like Daily
// Report); each todo is a SUBTASK under it in the WO's OWN task list. Each todo
// carries: name = title; `to_do-s` = STATUS pick-list (default "Open"); native task
// priority = URGENCY; `work_order_hash` = the parent WO# (backlink + so the todo is
// picked up by the same portal-wide query the board uses). The ASSIGNEE is
// backend-managed: it's stashed in the subtask description as a plain-text token
// `fhi-todo-v1:<b64url>` (mirrors the visits token so Zoho sanitization can't strip
// it) alongside a human "Assigned: <name>" line; both are stripped from the notes on
// read. "Completed" status → ARCHIVE (close the subtask); any other status → reopen.
//------------------------------------------------------------------------------

// Plain-text base64url token carrying the todo's assignee + owning WO id. Same rationale
// as the visits token: base64url is [A-Za-z0-9_-] only, so it survives Zoho's rich-text
// sanitization intact (an HTML comment would be stripped).
const TODO_TOKEN_RE = /fhi-todo-v1:([A-Za-z0-9_-]+)/;
// Plain-text base64url token carrying the full Visit JSON (start/end/attendees/label/
// calendarId/eventId/htmlLink) for round-trip — see visitSubtaskDescription/visitFromSubtask.
// base64url is [A-Za-z0-9_-] only, so it survives Zoho's rich-text sanitization intact. The
// `fhi-visit-v1:` prefix is distinct from the todo token's `fhi-todo-v1:`, so they never cross-match.
const VISIT_TOKEN_RE = /fhi-visit-v1:([A-Za-z0-9_-]+)/;
// The human-readable "Assigned: <name>" line kept in the visible notes (stripped on read).
const TODO_ASSIGNED_LINE_RE = /^\s*Assigned:.*$/gim;

interface TodoTokenPayload {
  assignee: string | null;
  workOrderId: string | null;
}

/** The `to_do-s` value on a task (raw custom field), trimmed; "" when absent. */
function todoStatusRaw(env: Env, task: zoho.ZohoTask): string {
  const f = todoStatusFieldName(env);
  const raw = (task?.raw?.[f] ?? task?.customFields?.[f]) as unknown;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * A TODO subtask is identified by the DURABLE `fhi-todo-v1:` token buildTodoDescription writes
 * — NOT by to_do_s presence (that pick-list now has a DEFAULT value on EVERY task, so presence
 * matches Action/Billing/visit/item tasks too). The token is only ever written on real todos,
 * so it never collides with a visit (Start:/Google Event:) or an item ([src-wo-id:]).
 */
function isTodoSubtask(_env: Env, task: zoho.ZohoTask): boolean {
  return TODO_TOKEN_RE.test(htmlToText(task.description ?? ""));
}

/** True when a status string means the todo is done/archived ("Completed", case-insensitive). */
function isTodoCompletedStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "completed";
}

/** Parse the fhi-todo-v1 token from a description; tolerant of Zoho's HTML wrapping. */
function parseTodoToken(desc: string): TodoTokenPayload {
  const plain = htmlToText(desc);
  const m = plain.match(TODO_TOKEN_RE);
  if (m) {
    try {
      const obj = JSON.parse(b64urlDecode(m[1])) as Partial<TodoTokenPayload>;
      return {
        assignee: typeof obj.assignee === "string" && obj.assignee.trim() ? obj.assignee : null,
        workOrderId: typeof obj.workOrderId === "string" && obj.workOrderId.trim() ? obj.workOrderId : null,
      };
    } catch {
      /* fall through */
    }
  }
  return { assignee: null, workOrderId: null };
}

/** The user-facing notes: strip the token and the human "Assigned:" line. */
function cleanTodoNotes(desc: string): string {
  return htmlToText(desc)
    .replace(TODO_TOKEN_RE, "")
    .replace(TODO_ASSIGNED_LINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Build a todo subtask description: the human notes, a legible "Assigned: <name>" line,
 * and the machine token (last). Parsing is order-independent, but a stable writer keeps
 * re-reads idempotent (mirrors buildPurchaseDescription).
 */
function buildTodoDescription(notes: string | null, assignee: string | null, workOrderId: string | null): string {
  const cleanAssignee = assignee && assignee.trim() ? assignee.trim() : null;
  const payload: TodoTokenPayload = { assignee: cleanAssignee, workOrderId: workOrderId ?? null };
  const token = `fhi-todo-v1:${b64urlEncode(JSON.stringify(payload))}`;
  const parts: string[] = [];
  if (notes && notes.trim()) parts.push(notes.trim());
  if (cleanAssignee) parts.push(`Assigned: ${cleanAssignee}`);
  parts.push(token);
  return parts.join("\n");
}

/** Build a Todo from a normalized to-do subtask. `workOrderIdOverride` wins when known (per-WO path). */
function todoFromTask(env: Env, task: zoho.ZohoTask, workOrderIdOverride: string | null): Todo {
  const status = todoStatusRaw(env, task) || DEFAULT_TODO_STATUS;
  const token = parseTodoToken(task.description ?? "");
  const workOrderNumber =
    task.workOrderHash ?? (task.raw?.work_order_hash as string | undefined) ?? task.customFields[woFieldName(env)] ?? null;
  return {
    id: task.id,
    title: task.name,
    status,
    // URGENCY = native task priority (none|low|medium|high); pass through, null when unset.
    urgency: task.priority ?? null,
    assignee: token.assignee,
    notes: cleanTodoNotes(task.description ?? "") || null,
    workOrderId: workOrderIdOverride ?? token.workOrderId ?? "",
    workOrderNumber,
    // Archived === the todo reached "Completed" (status-derived, like purchasing's DONE set),
    // OR its Zoho subtask is completed directly. Un-archives when the status moves back.
    archived: task.isCompleted || isTodoCompletedStatus(status),
    createdAt: task.createdAt ?? task.createdTime ?? null,
    updatedAt: task.updatedAt ?? task.lastModifiedTime ?? null,
  };
}

/**
 * Build the Todo[] for one WO from ALREADY-FETCHED project subtasks + the WO's To-Dos
 * task id. Kept synchronous (no API calls) so getWorkOrder can hydrate wo.todos inline
 * without recursing back into listTodos. Excludes archived unless includeArchived.
 */
function todosFromSubtasks(
  env: Env,
  woTagged: zoho.ZohoTask[],
  actionTaskId: string,
  includeArchived: boolean
): Todo[] {
  // Match to this WO by the todo token's workOrderId — robust against the portal filter
  // omitting parental_info.parent_task_id (the same has_parents caveat that broke the
  // items dashboard). `woTagged` = tasks carrying this WO's work_order_hash.
  let todos = woTagged
    .filter((t) => isTodoSubtask(env, t))
    .map((t) => todoFromTask(env, t, null))
    .filter((t) => t.workOrderId === actionTaskId);
  if (!includeArchived) todos = todos.filter((t) => !t.archived);
  return todos.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/**
 * Find the WO's "Action Items" holder task (in its task list); create it if missing. Accepts
 * the legacy "To-Dos" name so pre-change WOs reuse their existing holder instead of getting a
 * duplicate. Returns the holder task id.
 */
async function ensureActionItemsTask(env: Env, projectId: string, taskListId: string): Promise<string> {
  const tasks = await zoho.getTasksByProject(env, projectId);
  const existing = tasks.find(
    (t) => t.taskListId === taskListId && ACTION_ITEMS_HOLDER_NAMES.includes(t.name)
  );
  if (existing) return existing.id;
  const created = await zoho.createTask(env, projectId, { name: ACTION_ITEMS_TASK_NAME, taskListId });
  return created.id;
}

/**
 * Add a to-do to a work order. A todo is a SUBTASK under the WO's "Action Items" holder, carrying
 * the `to_do-s` status (default "Open"), the native task priority (urgency), a description
 * with the assignee token, and `work_order_hash` = the WO#. "Completed" archives it (the
 * subtask is closed). Field writes + open/close are best-effort. Returns the created Todo,
 * or null if the WO isn't found.
 */
export async function addTodo(
  env: Env,
  actionTaskId: string,
  input: CreateTodoInput
): Promise<Todo | null> {
  const wo = await getWorkOrder(env, actionTaskId);
  if (!wo) return null;

  const holderId = await ensureActionItemsTask(env, wo.projectId, wo.taskListId);
  const status = input.status?.trim() || DEFAULT_TODO_STATUS;
  const assignee = input.assignee?.trim() || null;
  const description = buildTodoDescription(input.notes ?? null, assignee, actionTaskId);

  // Action items are subtasks under the WO's dedicated "Action Items" holder task — NOT the
  // Action task — so they stay out of "Work Order Tasks". Identity/listing is by the
  // fhi-todo-v1 token (the description carries actionTaskId), independent of the parent.
  const task = await zoho.createTask(env, wo.projectId, {
    name: input.title,
    taskListId: wo.taskListId,
    description,
    parentTaskId: holderId,
    // URGENCY = native task priority; createTask validates/lowercases (none|low|medium|high).
    priority: input.priority,
  });

  // Set to_do-s (status) + work_order_hash (backlink / portal-query pickup) — best-effort.
  try {
    await zoho.setTaskFields(env, wo.projectId, task.id, {
      [todoStatusFieldName(env)]: status,
      [woFieldName(env)]: wo.workOrderNumber,
    });
  } catch (e) {
    console.warn("addTodo: setTaskFields (to_do-s / work_order_hash) failed (non-fatal):", e);
  }

  // Completed → archive (close the subtask). Best-effort: don't fail create on a close hiccup.
  if (isTodoCompletedStatus(status)) {
    try {
      await zoho.setTaskCompleted(env, wo.projectId, task.id, true);
    } catch (e) {
      console.warn("addTodo: setTaskCompleted (archive) failed (non-fatal):", e);
    }
  }

  // Re-read so the returned Todo reflects the written fields; fall back to a patched copy.
  const refreshed = await zoho.getTask(env, wo.projectId, task.id).catch(() => null);
  const t: zoho.ZohoTask = refreshed ?? {
    ...task,
    raw: { ...(task.raw ?? {}), [todoStatusFieldName(env)]: status, [woFieldName(env)]: wo.workOrderNumber },
  };
  return todoFromTask(env, t, actionTaskId);
}

/**
 * List a work order's to-dos (the subtasks under its To-Dos task). Excludes archived by
 * default; includeArchived returns all. Returns [] if the WO (or its To-Dos task) is absent.
 */
export async function listTodos(
  env: Env,
  actionTaskId: string,
  includeArchived = false
): Promise<Todo[]> {
  // Reuse the central dashboard query (proven work_order_hash portal filter), then keep this
  // WO's todos (matched by the token's workOrderId) — mirrors listItemsForWo reusing listPurchasing.
  const all = await listAllTodos(env, { includeArchived });
  return all.filter((t) => t.workOrderId === actionTaskId);
}

/**
 * Update a to-do (title / status / priority / notes / assignee). The todo is a subtask in
 * its WO's SERVICE project. Status "Completed" archives it (close the subtask); any other
 * status reopens it. Field writes + open/close are best-effort. Returns the refreshed Todo,
 * or null if the WO or the todo id isn't found.
 */
export async function updateTodo(
  env: Env,
  actionTaskId: string,
  todoId: string,
  patch: UpdateTodoInput
): Promise<Todo | null> {
  // Locate the todo subtask by id via the proven portal filter (not has_parents), like
  // updatePurchase — this yields its projectId directly.
  const found = await zoho.listPortalTasksByFilter(
    env,
    JSON.stringify({ criteria: [{ field_name: "id", criteria_condition: "is", value: [todoId] }], pattern: "1" })
  );
  const current = found[0];
  if (!current || !current.projectId || !isTodoSubtask(env, current)) return null;
  const projectId = current.projectId;

  // Title / status / priority are top-level task fields set via a single PATCH (best-effort).
  const fields: Record<string, string> = {};
  if (patch.title !== undefined) fields.name = patch.title;
  if (patch.status !== undefined) fields[todoStatusFieldName(env)] = patch.status;
  if (patch.priority !== undefined) {
    const p = String(patch.priority).toLowerCase();
    if (["none", "low", "medium", "high"].includes(p)) fields.priority = p;
  }
  if (Object.keys(fields).length) {
    try {
      await zoho.setTaskFields(env, projectId, todoId, fields);
    } catch (e) {
      console.warn("updateTodo: setTaskFields (title/status/priority) failed (non-fatal):", e);
    }
  }

  // Notes and/or assignee rewrite the description, preserving the untouched half + the WO id.
  if (patch.notes !== undefined || patch.assignee !== undefined) {
    const token = parseTodoToken(current.description ?? "");
    const newNotes = patch.notes !== undefined ? patch.notes : cleanTodoNotes(current.description ?? "");
    const newAssignee = patch.assignee !== undefined ? (patch.assignee?.trim() || null) : token.assignee;
    const workOrderId = token.workOrderId ?? actionTaskId;
    try {
      await zoho.setTaskDescription(env, projectId, todoId, buildTodoDescription(newNotes, newAssignee, workOrderId));
    } catch (e) {
      console.warn("updateTodo: setTaskDescription (notes/assignee) failed (non-fatal):", e);
    }
  }

  // Completed → archive; any other status → reopen. Best-effort (don't fail on a hiccup).
  if (patch.status !== undefined) {
    try {
      await zoho.setTaskCompleted(env, projectId, todoId, isTodoCompletedStatus(patch.status));
    } catch (e) {
      console.warn("updateTodo: complete/reopen (setTaskCompleted) failed (non-fatal):", e);
    }
  }

  const refreshed = await zoho.getTask(env, projectId, todoId).catch(() => null);
  return refreshed ? todoFromTask(env, refreshed, actionTaskId) : null;
}

/**
 * The CENTRAL to-dos dashboard across ALL work orders. Reuses the portal-wide subtask
 * query (the has_parents variant of the board's portal query — the same one the Items
 * dashboard uses, since todos are subtasks that carry `work_order_hash`), then KEEPS only
 * the subtasks with a non-empty `to_do-s` value (that's what marks a task as a todo). By
 * default archived todos are EXCLUDED; includeArchived returns all. Optional assignee /
 * status / urgency filters are applied case-insensitively (exact match). Each Todo carries
 * its workOrderNumber (from work_order_hash) so the UI can deep-link.
 */
export async function listAllTodos(
  env: Env,
  opts: { includeArchived?: boolean; assignee?: string; status?: string; urgency?: string } = {}
): Promise<Todo[]> {
  // Proven work_order_hash portal filter (contains "-WO-") — NOT has_parents/getPortalSubtasks,
  // which didn't return subtasks live (the items-dashboard bug). Todo subtasks carry
  // work_order_hash (tagged on create), so the filter returns them; keep those with a to_do-s
  // status (= todos, vs Action/Billing/visit/item tasks).
  const tasks = await listWoTaggedTasks(env);
  let todos = tasks
    .filter((t) => isTodoSubtask(env, t))
    .map((t) => todoFromTask(env, t, null));

  if (!opts.includeArchived) todos = todos.filter((t) => !t.archived);

  const eq = (a: string | null, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
  if (opts.assignee && opts.assignee.trim()) todos = todos.filter((t) => eq(t.assignee, opts.assignee as string));
  if (opts.status && opts.status.trim()) todos = todos.filter((t) => eq(t.status, opts.status as string));
  if (opts.urgency && opts.urgency.trim()) todos = todos.filter((t) => eq(t.urgency, opts.urgency as string));

  return todos.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

//==============================================================================
// Assembly + helpers
//==============================================================================

interface TicketPair {
  action: zoho.ZohoTask | null;
  billing: zoho.ZohoTask | null;
  statusTask: zoho.ZohoTask | null; // the "Work Order Status" task (wo_cycle_status), when migrated
  others: zoho.ZohoTask[];   // non-Action/Billing tasks in this ticket (visit/item/todo subtasks)
}

/** Group a project's tasks into tickets keyed by task-list id, picking Action/Billing/Status. */
export function groupTicketsFromTasks(tasks: zoho.ZohoTask[]): Map<string, TicketPair> {
  const map = new Map<string, TicketPair>();
  for (const t of tasks) {
    if (!t.taskListId) continue;
    const pair = map.get(t.taskListId) ?? { action: null, billing: null, statusTask: null, others: [] };
    if (t.name === ACTION_TASK_NAME) pair.action = t;
    else if (t.name === BILLING_TASK_NAME) pair.billing = t;
    else if (t.name === STATUS_TASK_NAME) pair.statusTask = t;
    else pair.others.push(t);
    map.set(t.taskListId, pair);
  }
  return map;
}

async function woFromParts(
  env: Env,
  project: zoho.ZohoProject,
  taskListId: string,
  listDone: boolean,
  action: zoho.ZohoTask,
  billing: zoho.ZohoTask | null,
  accessCodes: AccessCodes,
  dailyReportTaskId: string | null,
  visits: Visit[],
  todoTaskId: string | null,
  todos: Todo[],
  statusTask: zoho.ZohoTask | null = null
): Promise<WorkOrder> {
  // Prefer the portal-query field (workOrderHash) — the per-project task endpoint
  // often omits the custom field, which blanked the WO number on the detail view.
  const woNumber = action.workOrderHash ?? action.customFields[woFieldName(env)] ?? "";
  // Visits are read by the caller from the WO's "Schedule" subtasks (legible), with a
  // legacy base64-trailer fallback for un-migrated WOs.
  const wo = assembleWorkOrder(env, project, taskListId, listDone, action, billing, accessCodes, visits, woNumber, dailyReportTaskId, todoTaskId, statusTask);
  // DETAIL path: hydrate hours from Postgres (self-managed; not in Zoho).
  wo.hours = await hoursRepo.getHours(env, action.id);
  // DETAIL path: hydrate todos (already built from the fetched subtasks by the caller).
  wo.todos = todos;
  return wo;
}

/**
 * Build a WorkOrder straight from the portal-task rows returned by the single
 * filtered portal query (LIST path). No extra Zoho calls: everything needed is
 * already on the task — the WO# (work_order_hash), project id/name, task-list
 * name, priority, timestamps — and the Billing task's closed flag comes from the
 * same query because Billing is tagged with the WO# too. Per-WO detail that isn't
 * cheap to carry in the list (access codes, schedule, notes) is intentionally
 * left null here; it's hydrated by getWorkOrder on the detail view.
 */
function woFromPortalTask(
  env: Env,
  taskListId: string,
  action: zoho.ZohoTask,
  billing: zoho.ZohoTask | null,
  others: zoho.ZohoTask[] = [],
  statusTask: zoho.ZohoTask | null = null
): WorkOrder {
  const workOrderNumber = action.workOrderHash ?? "";
  const parsed = parseWoNumber(workOrderNumber);
  const projectName = action.projectName ?? "";
  const status = deriveStatus(action, billing, false);
  // The portal task query returns the Action task DESCRIPTION, and the visits are
  // stored in that description (the fhi-visits trailer). So we hydrate visits here
  // with NO extra API call — which makes scheduleStatus (and the ?schedule filter)
  // real on the board, and lets the "when" column show the next visit.
  // LIST path can't fetch per-row subtasks, so: prefer the legacy trailer (un-migrated
  // WOs), else synthesize a single "next visit" from the mirrored wo_date_time field so
  // the board's scheduleStatus + "when" column still work for migrated WOs.
  // Prefer REAL visit subtasks — the SAME portal query already returns them (they carry
  // work_order_hash) and they were previously discarded. Hydrating from them gives full visits
  // (techs, confirmed, remote) on the board/calendar with NO extra API call, for every WO at once.
  let visits = sortVisits(others.filter((t) => isVisitSubtask(env, t)).map((t) => visitFromSubtask(env, t)));
  if (!visits.length) {
    // Legacy trailer (un-migrated WOs).
    visits = readVisits(action.description ?? "");
  }
  if (!visits.length) {
    // Last resort: synthesize one next-visit from wo_date_time + read the wo_schedule JSON marker
    // (pending/remote/techs) so the light indicators still work when there are no subtasks.
    const nextField = env.ZOHO_NEXTVISIT_FIELD || "wo_date_time";
    const nextRaw = (action.raw?.[nextField] ?? action.customFields?.[nextField]) as unknown;
    const nextDate = typeof nextRaw === "string" ? nextRaw.trim() : "";
    if (nextDate) {
      const schedField = env.ZOHO_VISITS_FIELD || "wo_schedule";
      const rawMarker = String((action.raw?.[schedField] ?? action.customFields?.[schedField]) ?? "").trim();
      let mPending = false, mRemote = false, mTechs: string[] = [];
      if (rawMarker.startsWith("{")) {
        try {
          const o = JSON.parse(rawMarker) as { p?: unknown; r?: unknown; t?: unknown };
          mPending = o.p === 1 || o.p === true;
          mRemote = o.r === 1 || o.r === true;
          mTechs = Array.isArray(o.t) ? o.t.filter((x): x is string => typeof x === "string" && !!x) : [];
        } catch {
          /* ignore malformed marker */
        }
      } else if (rawMarker) {
        const set = new Set(rawMarker.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean));
        mPending = set.has("pending");
        mRemote = set.has("remote");
      }
      visits = [{
        id: "next", start: nextDate, end: null, attendees: mTechs, label: null,
        calendarId: "", eventId: null, htmlLink: null,
        confirmed: mPending ? false : undefined, remote: mRemote || undefined,
      }];
    }
  }

  return {
    id: action.id,
    workOrderNumber,
    projectKey: parsed?.projectKey ?? "",
    mintedRef: parsed?.mintedRef ?? "",
    projectId: action.projectId ?? "",
    projectName,
    client: clientOf(projectName),
    siteAddress: addressOf(projectName),
    // Membership lives on the PROJECT; the single portal task query doesn't carry it,
    // so it's null on the light LIST path (avoids an N-per-row project fetch). The
    // detail view (getWorkOrder -> assembleWorkOrder) hydrates it from the project.
    membershipLevel: null,
    subject: stripWoPrefix(action.taskListName ?? `ticket-${taskListId}`, workOrderNumber, parsed?.projectKey ?? null),
    // CompanyCam URL lives as a TOP-LEVEL custom field on the task, so the single portal
    // query already carries it (no extra fetch) — populate it here like membership on detail.
    companyCamUrl: companyCamFromTask(env, action),
    // Provision URL is likewise a top-level custom field carried by the portal query.
    provision: provisionFromTask(env, action),
    woType: woTypeFromTask(env, action),
    billingStatus: billingStatusOf(env, billing),
    billable: billingStatusOf(env, billing) === "Billable",
    statusTaskId: statusTask?.id ?? null,
    cycleStatusRaw: taskField(statusTask, woCycleStatusFieldName(env)),
    status,
    scheduleStatus: deriveScheduleStatus(visits, status),
    woStatus: woStatusFromTasks(env, action, statusTask, status, deriveScheduleStatus(visits, status)),
    priority: action.priority,
    taskListId,
    actionTaskId: action.id,
    billingTaskId: billing?.id ?? null,
    // The Daily Report task isn't tagged with the WO#, so the single portal query
    // doesn't return it. Kept null on the light LIST path; getWorkOrder hydrates it.
    dailyReportTaskId: null,
    // Todos are subtasks (not returned by the light board query) — kept empty/null on
    // the LIST path; getWorkOrder hydrates them on the detail view. Central board is /todos.
    todoTaskId: null,
    todos: [],
    tasks: mainTasks(env, action, billing),
    // Board rows keep notes light; the detail view returns full notes.
    notes: null,
    accessCodes: { gate_code: null, community_gate: null, door_code: null },
    schedule: scheduleFromVisits(env, visits),
    visits,
    usedItems: usedItemsFromTask(env, action),
    // Board rows keep hours light (no per-row DB read); the detail view hydrates from Postgres.
    hours: { total: 0, entries: [] },
    createdAt: action.createdTime ?? null,
    updatedAt: action.lastModifiedTime ?? null,
  };
}

function assembleWorkOrder(
  env: Env,
  project: zoho.ZohoProject,
  taskListId: string,
  listDone: boolean,
  action: zoho.ZohoTask,
  billing: zoho.ZohoTask | null,
  accessCodes: AccessCodes,
  visits: Visit[],
  woNumber: string,
  dailyReportTaskId: string | null,
  todoTaskId: string | null,
  statusTask: zoho.ZohoTask | null = null
): WorkOrder {
  const status = deriveStatus(action, billing, listDone);
  const [projectKey, mintedRef] = splitWoNumber(woNumber, project.key);
  return {
    id: action.id,
    workOrderNumber: woNumber,
    projectKey,
    mintedRef,
    projectId: project.id,
    projectName: project.name,
    client: clientOf(project.name),
    siteAddress: projectSiteAddress(project),
    membershipLevel: membershipFromProject(env, project),
    subject: stripWoPrefix(taskListNameFallback(action, taskListId), woNumber, projectKey),
    companyCamUrl: companyCamFromTask(env, action),
    provision: provisionFromTask(env, action),
    woType: woTypeFromTask(env, action),
    billingStatus: billingStatusOf(env, billing),
    billable: billingStatusOf(env, billing) === "Billable",
    statusTaskId: statusTask?.id ?? null,
    cycleStatusRaw: taskField(statusTask, woCycleStatusFieldName(env)),
    status,
    // Scheduling is derived (never stored) from this WO's own visits + lifecycle + now.
    scheduleStatus: deriveScheduleStatus(visits, status),
    woStatus: woStatusFromTasks(env, action, statusTask, status, deriveScheduleStatus(visits, status)),
    priority: action.priority,
    taskListId,
    actionTaskId: action.id,
    billingTaskId: billing?.id ?? null,
    dailyReportTaskId,
    // Populated by woFromParts (detail path) via listTodos-equivalent; [] at create.
    todoTaskId,
    todos: [],
    tasks: mainTasks(env, action, billing),
    // Notes never leak the trailers or the human "Scheduled Visits" section.
    notes: cleanNotes(action.description ?? "") || null,
    accessCodes,
    // schedule = summary of the FIRST (earliest) visit; visits = the full list.
    schedule: scheduleFromVisits(env, visits),
    visits: sortVisits(visits),
    usedItems: usedItemsFromTask(env, action),
    // Hours are self-managed in Postgres; default to empty here (woFromParts hydrates on detail).
    hours: { total: 0, entries: [] },
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

/** The ticket's two main tasks (work + billing) for the app to display. */
function mainTasks(env: Env, action: zoho.ZohoTask, billing: zoho.ZohoTask | null): WorkOrderTask[] {
  const list: WorkOrderTask[] = [
    { id: action.id, name: action.name || ACTION_TASK_NAME, isCompleted: action.isCompleted, kind: "work", taskStatus: taskStatusOf(env, action) },
  ];
  if (billing) {
    list.push({ id: billing.id, name: billing.name || BILLING_TASK_NAME, isCompleted: billing.isCompleted, kind: "billing", taskStatus: taskStatusOf(env, billing) });
  }
  return list;
}

// --- name parsing: project name convention "Client, Name - Address - SERVICE" ---
function clientOf(projectName: string): string {
  return projectName.split(" - ")[0]?.trim() || projectName;
}
/**
 * Site address for a work order. Prefer Zoho's STRUCTURED site_address field
 * (carried on the normalized project) and fall back to parsing the project name
 * only when the structured field is empty — the name format is inconsistent
 * ("…Ave- SERVICE"), so the structured field is authoritative. Used by the WO
 * detail record AND the Google Calendar event `location` (the map pin).
 */
function projectSiteAddress(project: zoho.ZohoProject): string | null {
  return project.siteAddress ?? addressOf(project.name);
}
function addressOf(projectName: string): string | null {
  const parts = projectName.split(" - ");
  // middle segment(s) between client and the trailing "SERVICE"
  if (parts.length >= 3) return parts.slice(1, -1).join(" - ").trim();
  return null;
}

/**
 * Strip a leading WO-number prefix off a task-list / ticket name so the app's
 * `subject` stays the CLEAN entered text. The Zoho title now carries the SHORT WO
 * portion (`WO-2026-0017 - <subject>`), so we compute the same short form (the full
 * WO number minus the leading `<projectKey>-`) and peel it off first. For WOs created
 * BEFORE this change — whose title carried the FULL number (`FHI-816-WO-2026-0017 -
 * <subject>`) — we then also try the full form, so existing WOs still read cleanly.
 * Each match is case-insensitive and tolerant of extra spaces around the dash.
 * Returns the remainder on the first match, or the name unchanged when neither matches.
 */
function stripWoPrefix(name: string, woNumber: string, projectKey?: string | null): string {
  if (!name || !woNumber) return name;
  const shortWo =
    projectKey && woNumber.startsWith(projectKey + "-")
      ? woNumber.slice(projectKey.length + 1)
      : woNumber;
  // Try the SHORT form first (current titles), then the FULL form (pre-change back-compat).
  for (const candidate of [shortWo, woNumber]) {
    if (!candidate) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^\\s*${escaped}\\s*-\\s*`, "i");
    if (re.test(name)) return name.replace(re, "");
  }
  return name;
}

/**
 * Read the CompanyCam URL off an Action task. The value is a TOP-LEVEL custom field
 * on the raw task payload (same shape as work_order_hash / wo_used_items); fall back
 * to the normalized customFields map, then null. Returns null when the field is
 * unconfigured (feature off) — no guessing a field name.
 */
function companyCamFromTask(env: Env, action: zoho.ZohoTask): string | null {
  const field = companyCamFieldName(env);
  if (!field) return null;
  const raw = action?.raw?.[field];
  if (typeof raw === "string" && raw.trim()) return raw;
  const cf = action.customFields[field];
  return cf && cf.trim() ? cf : null;
}

/**
 * Read the provision-ticket URL off an Action task. The value lives as a TOP-LEVEL
 * custom field on the raw task payload (same shape as work_order_hash / the CompanyCam
 * field); fall back to the normalized customFields map. DEFAULTS to "" when unset OR
 * when the `provision` field doesn't exist in Zoho yet — never null, never throws — so
 * the front-end header can render the link (or hide it) and the UI keeps working until
 * the admin creates the field.
 */
function provisionFromTask(env: Env, action: zoho.ZohoTask): string {
  const field = provisionFieldName(env);
  const raw = action?.raw?.[field];
  if (typeof raw === "string" && raw.trim()) return raw;
  const cf = action.customFields[field];
  return cf && cf.trim() ? cf : "";
}
function woTypeFromTask(env: Env, action: zoho.ZohoTask): string {
  const field = woTypeFieldName(env);
  const raw = action?.raw?.[field];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const cf = action.customFields[field];
  return cf && cf.trim() ? cf.trim() : "";
}

function splitWoNumber(full: string, projectKey: string | null): [string, string] {
  const m = full.match(/^(.*)-WO-(\d{4}-\d+)$/);
  if (m) return [m[1], m[2]];
  return [projectKey ?? "", ""];
}

function taskListNameFallback(action: zoho.ZohoTask, taskListId: string): string {
  // We don't always carry the task-list name on the task; callers that need the
  // real ticket name can hydrate it. Fall back to the id.
  return (action.raw?.tasklist?.name as string) ?? `ticket-${taskListId}`;
}

function accessCodesFromProject(project: zoho.ZohoProject): AccessCodes {
  return {
    gate_code: project.customFields["gate_code"] ?? null,
    community_gate: project.customFields["community_gate"] ?? null,
    door_code: project.customFields["door_code"] ?? null,
  };
}

/**
 * Read the client's support membership level off a project. The value is a
 * TOP-LEVEL custom field on the raw project payload (confirmed live); fall back to
 * the normalized customFields map, then null when absent. Field name is configurable
 * (config.membershipFieldName, default "support_membership_actual").
 */
/** Write a project's support-membership level (S1b — editable on the Projects dashboard). */
export async function setProjectMembership(env: Env, projectId: string, value: string): Promise<void> {
  await zoho.updateProjectFields(env, projectId, { [membershipFieldName(env)]: value });
  await invalidateProjectCaches(env, projectId);
}

function membershipFromProject(env: Env, project: zoho.ZohoProject): string | null {
  const field = membershipFieldName(env);
  const raw = project.raw?.[field];
  if (typeof raw === "string" && raw.trim()) return raw;
  const cf = project.customFields[field];
  return cf ?? null;
}

function formatAccessCodes(c: AccessCodes): string | null {
  const parts: string[] = [];
  if (c.gate_code) parts.push(`Gate: ${c.gate_code}`);
  if (c.community_gate) parts.push(`Community: ${c.community_gate}`);
  if (c.door_code) parts.push(`Door: ${c.door_code}`);
  return parts.length ? parts.join(" / ") : null;
}

function matchesQuery(wo: WorkOrder, q?: string): boolean {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return true; // empty/missing/whitespace-only q = no search filter
  return (
    wo.workOrderNumber.toLowerCase().includes(needle) ||
    wo.client.toLowerCase().includes(needle) ||
    (wo.siteAddress ?? "").toLowerCase().includes(needle) ||
    wo.subject.toLowerCase().includes(needle)
  );
}

function sortWorkOrders(list: WorkOrder[], sort: WorkOrderSort): WorkOrder[] {
  const arr = [...list];
  switch (sort) {
    case "oldest":
      return arr.sort((a, b) => cmp(a.createdAt, b.createdAt));
    case "client":
      return arr.sort((a, b) => a.client.localeCompare(b.client));
    case "priority":
      return arr.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    case "newest":
    default:
      return arr.sort((a, b) => cmp(b.createdAt, a.createdAt));
  }
}
function cmp(a: string | null, b: string | null): number {
  return String(a ?? "").localeCompare(String(b ?? ""));
}
function priorityRank(p: string | null): number {
  switch ((p ?? "").toLowerCase()) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

// --- legacy event-meta trailer (READ-ONLY now: used only for migration) ---
function readEventMeta(desc: string): EventMeta | null {
  const m = desc.match(EVENT_META_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as EventMeta;
  } catch {
    return null;
  }
}
function stripEventMeta(desc: string): string {
  return desc.replace(EVENT_META_RE, "").trimEnd();
}

// --- visits trailer helpers (stored inside the Action description) ---

/**
 * Read the visits list off a description. Prefers the fhi-visits JSON trailer;
 * MIGRATION: if there's no visits trailer but the OLD single fhi-cal meta is
 * present, treat that one event as a single visit. We may not have its start/end
 * (times lived only on the calendar event), so those are null — but the
 * eventId/calendarId are preserved so the event stays reachable.
 */
function readVisits(desc: string): Visit[] {
  // Current format: plain-text base64url token, tolerant of Zoho's HTML wrapping.
  const plain = htmlToText(desc);
  const tok = plain.match(VISITS_TOKEN_RE);
  if (tok) {
    try {
      const arr = JSON.parse(b64urlDecode(tok[1]));
      if (Array.isArray(arr)) return arr as Visit[];
    } catch {
      /* fall through */
    }
  }
  // LEGACY: old html-comment trailer (pre-2026-08-20), if any survived a save.
  const m = plain.match(VISITS_META_RE) ?? desc.match(VISITS_META_RE);
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) return arr as Visit[];
    } catch {
      /* fall through to migration / empty */
    }
  }
  const legacy = readEventMeta(desc);
  if (legacy) {
    return [
      {
        id: crypto.randomUUID(),
        start: null,
        end: null,
        attendees: [],
        label: null,
        calendarId: legacy.calendarId,
        eventId: legacy.eventId,
        htmlLink: null,
      },
    ];
  }
  return [];
}

// RETIRED 2026-08-23: writeVisits — visits are no longer serialized into the Action
// description (they live as legible "Schedule" subtasks). readVisits + b64urlDecode are
// kept to READ the legacy base64 trailer for un-migrated WOs (fallback) and for migration.

// --- base64url + html helpers (visit-trailer READ + todo-token READ/WRITE) ---
/** Encode a UTF-8 string to base64url ([A-Za-z0-9_-], no padding) — survives Zoho sanitization. */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
/** Zoho returns the description as HTML; reduce it to plain text so the token matches. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Remove the visits section, the visits trailer, and the legacy fhi-cal trailer. */
function stripVisits(desc: string): string {
  return desc
    .replace(VISITS_TOKEN_RE, "")
    .replace(VISITS_META_RE, "")
    .replace(VISITS_SECTION_RE, "")
    .trimEnd();
}

/** The user-facing notes: no trailers, no "Scheduled Visits" section. */
function cleanNotes(desc: string): string {
  return stripEventMeta(stripVisits(desc)).trimEnd();
}

/** Summary Schedule from the FIRST (earliest by start) visit, or the empty default. */
function scheduleFromVisits(env: Env, visits: Visit[]): Schedule {
  const first = sortVisits(visits)[0];
  if (!first) {
    return { calendarId: env.DEFAULT_CALENDAR_ID, eventId: null, start: null, end: null, attendees: [], htmlLink: null };
  }
  return {
    calendarId: first.calendarId,
    eventId: first.eventId,
    start: first.start,
    end: first.end,
    attendees: first.attendees,
    htmlLink: first.htmlLink,
  };
}

/** Sort visits by start ascending; visits with no start sort last. */
function sortVisits(visits: Visit[]): Visit[] {
  return [...visits].sort((a, b) => {
    if (a.start === b.start) return 0;
    if (!a.start) return 1;
    if (!b.start) return -1;
    return a.start.localeCompare(b.start);
  });
}

/** The earliest visit (by start), or null when there are none. */
function earliestVisit(visits: Visit[]): Visit | null {
  return sortVisits(visits)[0] ?? null;
}

// RETIRED 2026-08-23: formatVisitLine / formatVisitWhen — the human "Scheduled Visits"
// section in the Action description is gone; visit subtasks carry their own legible names.
