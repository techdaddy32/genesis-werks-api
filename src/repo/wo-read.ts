//==============================================================================
// repo/wo-read.ts — READ side of work orders on Postgres (P2): the queries that
// hydrate a WorkOrder from v_work_orders + wo_tasks + visits + todos + hours,
// shared by repo/work-orders.ts (writes reload through here) and repo/visits.ts.
//
// No business rules (§8.9): lifecycle / schedule_status / wo_status_effective
// come from the 0001 view; this module only joins and serializes.
//==============================================================================

import type { Env, WorkOrder } from "../types";
import type { Tx } from "../db";
import { getCalendarSettings } from "../settings";
import { hoursForWorkOrderTx, type Hours } from "./hours";
import { findWorkOrderRef } from "./_shared";
import { serializeWorkOrder, type TaskRow, type VisitRow, type WoViewRow } from "../serialize/work-order";
import { serializeTodo, type TodoViewRow } from "../serialize/todo";

export const WO_VIEW_COLS = [
  "id", "public_key", "project_id", "minted_ref", "subject", "notes", "priority", "wo_status", "billing_status",
  "billable", "wo_type", "company_cam_url", "provision_url", "created_at", "updated_at", "custom",
  "project_key", "project_name", "client_name", "site_address", "membership_level", "gate_code", "community_gate",
  "door_code", "lifecycle", "schedule_status", "wo_status_effective", "work_task_id", "billing_task_id",
] as const;

/** Calendar context for the Postgres path: whether Google sync is on and the wire default calendar id. */
export interface CalendarContext {
  /** true iff a default Google calendar address is configured for the tenant (and calendar.enabled is not false). */
  enabled: boolean;
  /** The wire `calendarId` default (Schedule / Visit when the visit has no calendar row). */
  defaultCalendarId: string;
  /** calendars.id of the default calendar (tenant_settings calendar.default_id), when configured. */
  defaultCalendarRowId: string | null;
}

export async function calendarContextTx(tx: Tx, env: Env): Promise<CalendarContext> {
  const s = await getCalendarSettings(tx);
  const address = String(s["calendar.default_address"] ?? "").trim();
  const enabled = s["calendar.enabled"] !== false && !!address;
  return {
    enabled,
    defaultCalendarId: address || (env.DEFAULT_CALENDAR_ID ?? "") || "",
    defaultCalendarRowId: s["calendar.default_id"] ? String(s["calendar.default_id"]) : null,
  };
}

/** work_orders.id for a wire id (uuid or legacy external id), or null. */
export async function resolveWorkOrderId(tx: Tx, id: string): Promise<string | null> {
  return findWorkOrderRef(tx, id);
}

/** Visits (+ attendees, Google ids) for a set of WOs, ordered starts_at NULLS LAST. */
export async function visitRowsTx(tx: Tx, workOrderIds: string[]): Promise<VisitRow[]> {
  if (!workOrderIds.length) return [];
  return tx<VisitRow[]>`
    select v.id, v.work_order_id, v.starts_at, v.ends_at, v.label,
           cal_ext.external_id as calendar_external_id,
           ev_ext.external_id  as event_id,
           v.html_link, v.confirmed, v.confirm_todo_id, v.remote,
           coalesce(att.emails, array[]::text[]) as attendees
    from public.visits v
    left join public.external_ids cal_ext
      on cal_ext.tenant_id = v.tenant_id and cal_ext.entity = 'calendar'
     and cal_ext.entity_id = v.calendar_id and cal_ext.system = 'google_calendar_calendar'
    left join public.external_ids ev_ext
      on ev_ext.tenant_id = v.tenant_id and ev_ext.entity = 'visit'
     and ev_ext.entity_id = v.id and ev_ext.system = 'google_calendar_event'
    left join lateral (
      select array_agg(a.email order by a.position) as emails
      from public.visit_attendees a where a.visit_id = v.id and a.deleted_at is null
    ) att on true
    where v.tenant_id = public.app_tenant_id() and v.work_order_id = any(string_to_array(${workOrderIds.join(",")}, ',')::uuid[]) and v.deleted_at is null
    order by v.starts_at asc nulls last, v.created_at asc`;
}

export async function taskRowsTx(tx: Tx, workOrderIds: string[]): Promise<TaskRow[]> {
  if (!workOrderIds.length) return [];
  return tx<TaskRow[]>`
    select id, work_order_id, kind, name, task_status from public.wo_tasks
    where tenant_id = public.app_tenant_id() and work_order_id = any(string_to_array(${workOrderIds.join(",")}, ',')::uuid[])
      and kind in ('work', 'billing') and deleted_at is null
    order by (kind = 'work') desc, position asc`;
}

/** Active (non-archived) todos per WO, oldest first — the DETAIL hydration (WorkOrder.todos). */
export async function activeTodoRowsTx(tx: Tx, workOrderIds: string[]): Promise<TodoViewRow[]> {
  if (!workOrderIds.length) return [];
  return tx<TodoViewRow[]>`
    select id, work_order_id, work_order_number, title, status, urgency, assignee_name, notes, archived, created_at, updated_at
    from public.v_todos
    where tenant_id = public.app_tenant_id() and work_order_id = any(string_to_array(${workOrderIds.join(",")}, ',')::uuid[])
      and deleted_at is null and not archived
    order by created_at asc`;
}

interface HoursEntryRow {
  work_order_id: string;
  tech: string | null;
  hours: string | number;
  logged_at: Date;
  note: string | null;
}

/** Hours for many WOs in two queries (entries + totals). */
async function hoursByWoTx(tx: Tx, workOrderIds: string[]): Promise<Map<string, Hours>> {
  const out = new Map<string, Hours>();
  if (!workOrderIds.length) return out;
  const [entries, totals] = await Promise.all([
    tx<HoursEntryRow[]>`
      select work_order_id, tech, hours, logged_at, note from public.hours_entries
      where tenant_id = public.app_tenant_id() and work_order_id = any(string_to_array(${workOrderIds.join(",")}, ',')::uuid[]) and deleted_at is null
      order by work_order_id, position asc`,
    tx<{ work_order_id: string; total: string | number | null }[]>`
      select work_order_id, total from public.v_work_order_hours where work_order_id = any(string_to_array(${workOrderIds.join(",")}, ',')::uuid[])`,
  ]);
  for (const id of workOrderIds) out.set(id, { total: 0, entries: [] });
  for (const t of totals) out.get(t.work_order_id)!.total = t.total === null ? 0 : Number(t.total);
  for (const e of entries) {
    out.get(e.work_order_id)!.entries.push({
      tech: e.tech ?? null,
      hours: Number(e.hours),
      at: e.logged_at instanceof Date ? e.logged_at.toISOString() : new Date(e.logged_at).toISOString(),
      note: e.note ?? null,
    });
  }
  return out;
}

/** Hydrate WorkOrders for the given view rows (FILLED shape for list and detail alike, §8.5). */
export async function hydrateTx(tx: Tx, env: Env, rows: WoViewRow[]): Promise<WorkOrder[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [cal, tasks, visits, todos, hours] = await Promise.all([
    calendarContextTx(tx, env),
    taskRowsTx(tx, ids),
    visitRowsTx(tx, ids),
    activeTodoRowsTx(tx, ids),
    hoursByWoTx(tx, ids),
  ]);
  const by = <T extends { work_order_id: string }>(list: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const x of list) (m.get(x.work_order_id) ?? m.set(x.work_order_id, []).get(x.work_order_id)!).push(x);
    return m;
  };
  const tasksBy = by(tasks);
  const visitsBy = by(visits);
  const todosBy = by(todos);
  return rows.map((r) =>
    serializeWorkOrder(r, {
      tasks: tasksBy.get(r.id) ?? [],
      visits: visitsBy.get(r.id) ?? [],
      todos: (todosBy.get(r.id) ?? []).map(serializeTodo),
      hours: hours.get(r.id) ?? { total: 0, entries: [] },
      defaultCalendarId: cal.defaultCalendarId,
    })
  );
}

/** One WorkOrder by wire id (uuid or legacy external id); null when unknown / deleted. */
export async function loadWorkOrderTx(tx: Tx, env: Env, id: string): Promise<WorkOrder | null> {
  const woId = await resolveWorkOrderId(tx, id);
  if (!woId) return null;
  const rows = await tx<WoViewRow[]>`
    select ${tx(WO_VIEW_COLS)} from public.v_work_orders
    where tenant_id = public.app_tenant_id() and id = ${woId} and deleted_at is null limit 1`;
  if (!rows.length) return null;
  const [wo] = await hydrateTx(tx, env, rows);
  return wo;
}

/** Every live WO of the tenant (the board source; filters/sorts are applied by the caller). */
export async function loadBoardTx(tx: Tx, env: Env): Promise<WorkOrder[]> {
  const rows = await tx<WoViewRow[]>`
    select ${tx(WO_VIEW_COLS)} from public.v_work_order_board
    where tenant_id = public.app_tenant_id()
    order by created_at desc`;
  return hydrateTx(tx, env, rows);
}

/** The hours block alone (detail re-hydration helper used by tests/importers). */
export { hoursForWorkOrderTx };
