//==============================================================================
// serialize/work-order.ts — v_work_orders (+ child rows) → the exact types.ts
// WorkOrder / WorkOrderTask / Visit / Schedule wire shapes (data-model §4).
//
// Key ORDER matches service.ts assembleWorkOrder() exactly (the wire is the
// contract; test/pg-shape.test.ts asserts it). Values:
//   id / taskListId / statusTaskId / dailyReportTaskId / todoTaskId = work_orders.id
//     (synthesized — one uuid per WO; the app treats them as opaque deep-link ids)
//   actionTaskId / billingTaskId = the wo_tasks uuids (kind work / billing)
//   status / scheduleStatus / woStatus = the 0001 view columns (lifecycle,
//     schedule_status, wo_status_effective) — §5 rules, evaluated with now()
//   usedItems = [] (§8.1: used_items retired)
//   LIST path is FILLED (§8.5): membershipLevel, notes, accessCodes, todos, hours real.
//   `custom` — the ONE additive key (P2): always an object, "_"-keys hidden.
//==============================================================================

import type { AccessCodes, Schedule, Visit, WorkOrder, WorkOrderStatus, WorkOrderTask, ScheduleStatus } from "../types";
import { customOut, iso, pgTextArray } from "../repo/_shared";
import { sortVisits } from "../status";

/** One row of public.v_work_orders (the driver returns timestamptz as Date, numerics as strings). */
export interface WoViewRow {
  id: string;
  public_key: string;
  project_id: string;
  minted_ref: string;
  subject: string;
  notes: string | null;
  priority: string | null;
  wo_status: string;
  billing_status: string;
  billable: boolean;
  wo_type: string;
  company_cam_url: string | null;
  provision_url: string;
  created_at: Date;
  updated_at: Date;
  custom: unknown;
  project_key: string;
  project_name: string;
  client_name: string | null;
  site_address: string | null;
  membership_level: string | null;
  gate_code: string | null;
  community_gate: string | null;
  door_code: string | null;
  lifecycle: WorkOrderStatus;
  schedule_status: ScheduleStatus;
  wo_status_effective: string;
  work_task_id: string | null;
  billing_task_id: string | null;
}

export interface TaskRow {
  id: string;
  work_order_id: string;
  kind: string;
  name: string;
  task_status: string;
}

export interface VisitRow {
  id: string;
  work_order_id: string;
  starts_at: Date | null;
  ends_at: Date | null;
  label: string | null;
  calendar_external_id: string | null;
  event_id: string | null;
  html_link: string | null;
  confirmed: boolean;
  confirm_todo_id: string | null;
  remote: boolean;
  attendees: string[] | string | null;
}

export interface WoParts {
  tasks: TaskRow[];
  visits: VisitRow[];
  todos: WorkOrder["todos"];
  hours: WorkOrder["hours"];
  /** The wire calendar id when a visit has no calendar row (Schedule/Visit.calendarId). */
  defaultCalendarId: string;
}

/** Zoho path convention: the text before the first " - " of the project name. */
export function clientOf(projectName: string): string {
  return projectName.split(" - ")[0]?.trim() || projectName;
}

export function serializeTask(r: TaskRow): WorkOrderTask {
  return {
    id: r.id,
    name: r.name,
    isCompleted: r.task_status === "Completed",
    kind: r.kind === "billing" ? "billing" : "work",
    taskStatus: r.task_status,
  };
}

export function serializeVisit(r: VisitRow, defaultCalendarId: string): Visit {
  return {
    id: r.id,
    start: iso(r.starts_at),
    end: iso(r.ends_at),
    attendees: pgTextArray(r.attendees),
    label: r.label ?? null,
    calendarId: r.calendar_external_id ?? defaultCalendarId,
    eventId: r.event_id ?? null,
    htmlLink: r.html_link ?? null,
    confirmed: r.confirmed !== false,
    confirmTodoId: r.confirm_todo_id ?? null,
    remote: r.remote === true,
  };
}

/** Summary Schedule from the FIRST (earliest by start) visit, or the empty default. */
export function scheduleFromVisits(visits: Visit[], defaultCalendarId: string): Schedule {
  const first = sortVisits(visits)[0];
  if (!first) {
    return { calendarId: defaultCalendarId, eventId: null, start: null, end: null, attendees: [], htmlLink: null };
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

export function accessCodesOf(r: Pick<WoViewRow, "gate_code" | "community_gate" | "door_code">): AccessCodes {
  return {
    gate_code: r.gate_code ?? null,
    community_gate: r.community_gate ?? null,
    door_code: r.door_code ?? null,
  };
}

/** The full WorkOrder (list and detail share the FILLED shape, §8.5). */
export function serializeWorkOrder(r: WoViewRow, parts: WoParts): WorkOrder {
  const tasks = parts.tasks
    .filter((t) => t.kind === "work" || t.kind === "billing")
    .sort((a, b) => (a.kind === "work" ? -1 : 0) - (b.kind === "work" ? -1 : 0))
    .map(serializeTask);
  const visits = sortVisits(parts.visits.map((v) => serializeVisit(v, parts.defaultCalendarId)));
  const woStatus = r.wo_status_effective;
  return {
    id: r.id,
    workOrderNumber: r.public_key,
    projectKey: r.project_key,
    mintedRef: r.minted_ref,
    projectId: r.project_id,
    projectName: r.project_name,
    client: r.client_name ?? clientOf(r.project_name),
    siteAddress: r.site_address ?? null,
    membershipLevel: r.membership_level ?? null,
    subject: r.subject,
    companyCamUrl: r.company_cam_url || null,
    provision: r.provision_url ?? "",
    woType: r.wo_type ?? "",
    billingStatus: r.billing_status,
    billable: r.billing_status === "Billable",
    statusTaskId: r.id,
    cycleStatusRaw: r.wo_status ?? "",
    status: r.lifecycle,
    scheduleStatus: r.schedule_status,
    woStatus,
    priority: r.priority ?? null,
    taskListId: r.id,
    actionTaskId: r.work_task_id ?? r.id,
    billingTaskId: r.billing_task_id ?? null,
    dailyReportTaskId: r.id,
    todoTaskId: r.id,
    todos: parts.todos,
    tasks,
    notes: r.notes || null,
    accessCodes: accessCodesOf(r),
    schedule: scheduleFromVisits(visits, parts.defaultCalendarId),
    visits,
    usedItems: [],
    hours: parts.hours,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    custom: customOut(r.custom),
  };
}
