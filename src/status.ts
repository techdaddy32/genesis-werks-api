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
