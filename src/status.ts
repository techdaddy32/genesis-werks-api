//==============================================================================
// status.ts — pure derivation of work-order lifecycle status.
//
// Per the canonical spec, status is NEVER stored. It is computed from the two
// tasks in the ticket (Action + Billing):
//
//   Action open                         -> "action"    (in progress)
//   Action closed, Billing open         -> "billing"   (ready to invoice)
//   Both closed (or task list completed)-> "completed"
//
// The task-list flag (active/completed) is only a coarse override: if the whole
// list is completed, the WO is completed regardless. The project status is
// irrelevant here (one client project holds many WOs).
//==============================================================================

import type { WorkOrderStatus, ScheduleStatus } from "./types";

/** Minimal task shape needed for the derivation (matches zoho.ts normalization). */
export interface TaskLike {
  isCompleted: boolean;
}

/**
 * Derive WO status from the Action task, the (optional) Billing task, and the
 * task-list completion flag.
 *
 * @param action        the Action task (required — a WO always has one)
 * @param billing       the Billing task, if present
 * @param taskListDone  whether the ticket task-list itself is marked completed
 */
export function deriveStatus(
  action: TaskLike | null,
  billing: TaskLike | null,
  taskListDone = false
): WorkOrderStatus {
  // Whole ticket closed out -> completed, no matter the individual tasks.
  if (taskListDone) return "completed";

  const actionClosed = action?.isCompleted ?? false;

  // Action still open -> the work is in progress.
  if (!actionClosed) return "action";

  // Action closed. If there's a Billing task and it's still open, we're invoicing.
  if (billing && !billing.isCompleted) return "billing";

  // Action closed and (no billing task OR billing closed) -> completed.
  return "completed";
}

/**
 * Derive the SCHEDULE status of a work order from its visits, its lifecycle
 * status, and the current time. Like lifecycle status, this is NEVER stored — it
 * is always computed fresh so it stays correct as time passes.
 *
 *   no dated visits at all            -> "unscheduled"
 *   at least one upcoming/ongoing     -> "scheduled"      (latest visit end >= now)
 *   all visits in the past, work done -> "scheduled"      (completed — don't nag)
 *   all visits in the past, still open-> "unscheduled"    (the scheduled date lapsed; needs re-booking)
 *
 * We look at each visit's END (falling back to its START when there's no end) and
 * take the LATEST across all visits: if the last visit hasn't finished yet, the WO
 * is still scheduled. Per Craig (2026-08-22): once a scheduled visit's date passes
 * with the work still open, the WO reverts to "unscheduled" (not "needs_reschedule")
 * so it shows up alongside brand-new WOs that need a visit booked. The "completed ->
 * scheduled" rule stays — once the work is done we don't flip a finished WO back to
 * unscheduled just because its visit is now in the past.
 */
export function deriveScheduleStatus(
  visits: { start: string | null; end: string | null }[],
  lifecycle: WorkOrderStatus,
  now: number = Date.now()
): ScheduleStatus {
  const times = visits
    .map((v) => v.end ?? v.start)
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n));
  if (times.length === 0) return "unscheduled";
  const latest = Math.max(...times);
  if (latest >= now) return "scheduled";            // at least one upcoming/ongoing visit
  if (lifecycle === "completed") return "scheduled"; // work is done — don't nag
  return "needs_reschedule";                         // scheduled date lapsed, work still open -> needs rescheduling
}

/**
 * Map a board filter chip to a predicate over derived status.
 *   active  -> action           (board default hides completed)
 *   billing -> billing
 *   done    -> completed
 *   all     -> everything
 */
export function statusMatchesFilter(
  status: WorkOrderStatus,
  filter: "active" | "billing" | "done" | "all"
): boolean {
  switch (filter) {
    case "active":
      return status === "action";
    case "billing":
      return status === "billing";
    case "done":
      return status === "completed";
    case "all":
      return true;
  }
}

//------------------------------------------------------------------------------
// The 7-state WO status vocabulary + the pure helpers that map between it, the
// legacy 3-state lifecycle and the scheduling states. Single-sourced here (P2)
// so the Zoho path (service.ts) and the Postgres path (repo/work-orders.ts)
// derive identical values. service.ts re-exports the public names.
//------------------------------------------------------------------------------

/** Auto (calendar-derived) statuses. */
export const WO_STATUS_SCHEDULING = ["Not Scheduled", "Scheduled", "Needs Reschedule"] as const;
/** Manual + sticky statuses (the back half). */
export const WO_STATUS_BACK_HALF = ["On Hold", "Active Monitoring", "Ready for Billing", "Waiting Payment", "Closed"] as const;
export const WO_STATUSES = [...WO_STATUS_SCHEDULING, ...WO_STATUS_BACK_HALF] as const;
/** Statuses a client may SEND (legacy spellings are normalized by normalizeWoStatus). */
export const WO_STATUS_INPUTS = [...WO_STATUSES, "Completed", "Needs Rescheduled"] as const;
/** Pre-billing statuses: the ones the all-tasks-complete rule auto-advances from. */
export const WO_STATUS_PRE_BILLING = [...WO_STATUS_SCHEDULING, "On Hold", "Active Monitoring"] as const;

/** The app-facing scheduling label per ScheduleStatus (wo_cycle_status spelling). */
export const CYCLE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  unscheduled: "Not Scheduled",
  scheduled: "Scheduled",
  needs_reschedule: "Needs Reschedule",
};

/** Normalize legacy / alternate spellings to the canonical label (Completed → Closed, Needs Rescheduled → Needs Reschedule). */
export function normalizeWoStatus(s: string): string {
  const t = (s ?? "").trim();
  if (t === "Completed") return "Closed";
  if (t === "Needs Rescheduled") return "Needs Reschedule";
  return t;
}

/** Map a woStatus to the legacy lifecycle (which tasks are open/closed). */
export function woStatusToLifecycle(s: string): WorkOrderStatus {
  const n = normalizeWoStatus(s);
  if (n === "Closed") return "completed";
  if (n === "Ready for Billing" || n === "Waiting Payment") return "billing";
  return "action"; // the three scheduling states + On Hold / Active Monitoring are all "active"
}

/** Lifecycle bucket for a woStatus label (board filters); unknown labels fall back to the derived lifecycle. */
export function lifecycleOfWoStatus(woStatus: string, fallback: WorkOrderStatus): WorkOrderStatus {
  const n = normalizeWoStatus(woStatus);
  return (WO_STATUSES as readonly string[]).includes(n) ? woStatusToLifecycle(n) : fallback;
}

/** True when a (normalized) label is one of the manual, sticky back-half statuses. */
export function isBackHalfStatus(s: string): boolean {
  return (WO_STATUS_BACK_HALF as readonly string[]).includes(normalizeWoStatus(s));
}

/** True when a stored status is still pre-billing (or unset). */
export function isPreBillingStatus(s: string): boolean {
  const n = normalizeWoStatus(s);
  return n === "" || (WO_STATUS_PRE_BILLING as readonly string[]).includes(n);
}

//------------------------------------------------------------------------------
// Board search / sort / visit ordering — pure, shared by both paths.
//------------------------------------------------------------------------------

/** Minimal WO shape the board search needs. */
export interface SearchableWo {
  workOrderNumber: string;
  client: string;
  siteAddress: string | null;
  subject: string;
}

/** Case-insensitive substring over WO#, client, site address, subject. Empty q = match all. */
export function matchesQuery(wo: SearchableWo, q?: string): boolean {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return true;
  return (
    wo.workOrderNumber.toLowerCase().includes(needle) ||
    wo.client.toLowerCase().includes(needle) ||
    (wo.siteAddress ?? "").toLowerCase().includes(needle) ||
    wo.subject.toLowerCase().includes(needle)
  );
}

export interface SortableWo {
  createdAt: string | null;
  client: string;
  priority: string | null;
}

/** newest = createdAt desc (string compare) · oldest asc · client localeCompare · priority rank. */
export function sortWorkOrders<T extends SortableWo>(list: T[], sort: "newest" | "oldest" | "client" | "priority"): T[] {
  const arr = [...list];
  switch (sort) {
    case "oldest":
      return arr.sort((a, b) => cmpStr(a.createdAt, b.createdAt));
    case "client":
      return arr.sort((a, b) => a.client.localeCompare(b.client));
    case "priority":
      return arr.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    case "newest":
    default:
      return arr.sort((a, b) => cmpStr(b.createdAt, a.createdAt));
  }
}
function cmpStr(a: string | null, b: string | null): number {
  return String(a ?? "").localeCompare(String(b ?? ""));
}
export function priorityRank(p: string | null): number {
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

/** Sort visits by start ascending; visits with no start sort last. */
export function sortVisits<T extends { start: string | null }>(visits: T[]): T[] {
  return [...visits].sort((a, b) => {
    if (a.start === b.start) return 0;
    if (!a.start) return 1;
    if (!b.start) return -1;
    return a.start.localeCompare(b.start);
  });
}
