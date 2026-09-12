//==============================================================================
// config.ts — the ONE place unknowns and cross-cutting knobs are resolved.
//
// Every value that depends on something a human still has to supply is read
// here (and only here), so there is a single audit surface for "what's unknown."
// Nothing in logic should hardcode a field name, id, or scope — pull it from a
// helper in this file.
//==============================================================================

import type { Env, OrderStatus } from "./types";

/** Marker used for env values that are placeholders, not real values. */
export const UNKNOWN_MARKER = "__TODO__";

/**
 * The order_status a part gets when it is first requested. One of the 7 real Zoho
 * pick-list options (confirmed by Craig, 2026-08-22; "Installed" re-added): "Needed"
 * is the default.
 */
export const DEFAULT_ORDER_STATUS: OrderStatus = "Needed";

/**
 * The Zoho task custom-field API/column name that stores the FULL composite
 * WO string (e.g. FHI-672-WO-2026-0001).
 *
 * TODO(craig): this is the single biggest unknown. Set env `ZOHO_WO_FIELD` to
 * the real field API name (Craig created a task field labeled "Work Orders #";
 * its internal API/column name is what Zoho's task API expects). Until then,
 * creation will refuse to write a bogus field — see assertWoFieldConfigured().
 */
export function woFieldName(env: Env): string {
  return env.ZOHO_WO_FIELD;
}

/** True when ZOHO_WO_FIELD is still a placeholder. */
export function isWoFieldConfigured(env: Env): boolean {
  return !!env.ZOHO_WO_FIELD && env.ZOHO_WO_FIELD !== UNKNOWN_MARKER;
}

/**
 * Fail loudly rather than silently writing to a made-up field. Callers that
 * must persist the WO number invoke this first.
 */
export function assertWoFieldConfigured(env: Env): void {
  if (!isWoFieldConfigured(env)) {
    throw new ConfigError(
      "ZOHO_WO_FIELD is not configured. Set it to the real Zoho task custom-field " +
        "API name for 'Work Orders #' before creating work orders. See README → BEFORE YOU DEPLOY."
    );
  }
}

/**
 * The Zoho PROJECT id of the FHI-907 purchasing project. Parts requested from a
 * work order become tasks here. Confirmed id: 1545398000015424003.
 */
export function purchasingProjectId(env: Env): string {
  return env.ZOHO_PURCHASING_PROJECT_ID || "";
}

/** True when the purchasing project id is configured. */
export function isPurchasingConfigured(env: Env): boolean {
  return !!purchasingProjectId(env);
}

/**
 * Fail loudly rather than write purchasing tasks to a made-up project. Callers
 * that touch the purchasing project invoke this first.
 */
export function assertPurchasingConfigured(env: Env): void {
  if (!isPurchasingConfigured(env)) {
    throw new ConfigError(
      "ZOHO_PURCHASING_PROJECT_ID is not configured. Set it to the FHI-907 " +
        "purchasing project id (1545398000015424003) before requesting parts."
    );
  }
}

/** The task pick-list custom-field API name that stores the order status. */
export function orderStatusFieldName(env: Env): string {
  return env.ZOHO_ORDER_STATUS_FIELD || "order_status";
}

/**
 * The purchasing order_status labels that count a requested part as DONE. This ONE
 * set drives BOTH (a) the WO-completion gate (a WO can't be moved to billing/completed
 * while it has requested parts in any OTHER status) AND (b) archiving (an item that
 * reaches a DONE status is completed in Zoho, so it drops off the active purchasing
 * list). Read from env ZOHO_ORDER_RESOLVED_STATUSES (comma-separated), defaulting to
 * ["Installed", "Not Needed", "Cancelled"]. Compared case-insensitively + trimmed.
 * NOTE: these must match the EXACT Zoho order_status option labels to have any effect.
 * PENDING (blocks completion, stays active) is therefore "Needed", "On Order",
 * "Received", "Backordered".
 *
 * `orderDoneStatuses` is the preferred name (the set now means "done", not just
 * "resolved for the gate"); `orderResolvedStatuses` is kept as a back-compat alias.
 */
export function orderDoneStatuses(env: Env): string[] {
  const raw = (env.ZOHO_ORDER_RESOLVED_STATUSES || "").trim();
  if (!raw) return [...DEFAULT_DONE_STATUSES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : [...DEFAULT_DONE_STATUSES];
}

/**
 * The full item-status vocabulary (the redesigned 7). Documentation/reference for the
 * status-map; the backend still passes whatever Zoho returns straight through and does
 * NOT enforce this list at runtime (Zoho owns its pick-list).
 *   Active (pending): Needed, On Order, Staged, Backordered
 *   Terminal (done):  Installed (From Stock), Installed (Field Purchase), Cancelled
 */
export const ITEM_STATUSES = [
  "Needed",
  "On Order",
  "Staged",
  "Backordered",
  "Installed (From Stock)",
  "Installed (Field Purchase)",
  "Cancelled", // Zoho's order_status option is two-L "Cancelled" (per wrangler.toml enumeration; one-L was rejected on the live write 2026-08-25)
] as const;

/**
 * DONE (terminal) default set. TRANSITIONAL: includes BOTH the redesigned terminal
 * statuses (the two Installed variants + Cancelled) AND the legacy labels (plain
 * "Installed", "Not Needed") so items tagged before the migration still archive / pass
 * the completion gate. Tighten to just the redesigned three via ZOHO_ORDER_RESOLVED_STATUSES
 * once the migration has re-tagged old data.
 */
const DEFAULT_DONE_STATUSES = [
  "Installed (From Stock)",
  "Installed (Field Purchase)",
  "Canceled", // Zoho's actual one-L label (confirmed 2026-08-23)
  // spelling + legacy safety net, kept during transition:
  "Cancelled",
  "Installed",
  "Not Needed",
] as const;

/**
 * The item statuses that mean "physically installed" (→ counts as a used item, and, in
 * the interim used-items feature, auto-creates/flags the linked used item). Both
 * redesigned variants plus the legacy plain "Installed". Override via
 * ZOHO_ORDER_INSTALLED_STATUSES (comma-separated); the older singular
 * ZOHO_ORDER_INSTALLED_STATUS is still honored as a fallback.
 */
export function orderInstalledStatuses(env: Env): string[] {
  const raw = (env.ZOHO_ORDER_INSTALLED_STATUSES || env.ZOHO_ORDER_INSTALLED_STATUS || "").trim();
  if (!raw) return ["Installed (From Stock)", "Installed (Field Purchase)", "Installed"];
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : ["Installed (From Stock)", "Installed (Field Purchase)", "Installed"];
}

/** Back-compat alias for orderDoneStatuses (see its doc for the unified done set). */
export function orderResolvedStatuses(env: Env): string[] {
  return orderDoneStatuses(env);
}


/**
 * The PROJECT custom-field API name for the client's support membership level
 * (e.g. "Needs Update"). Default "support_membership_actual" (confirmed live).
 */
export function membershipFieldName(env: Env): string {
  return env.ZOHO_MEMBERSHIP_FIELD || "support_membership_actual";
}

/**
 * The Zoho TASK custom-field API name for the CompanyCam URL, or null when unset.
 * NO DEFAULT — when null the whole CompanyCam feature no-ops (no reads, no writes),
 * so we never guess a field name. Set env ZOHO_COMPANYCAM_FIELD to the EXACT api
 * field_name of Craig's CompanyCam URL task field to turn the feature on.
 */
export function companyCamFieldName(env: Env): string | null {
  return env.ZOHO_COMPANYCAM_FIELD?.trim() || null;
}

/**
 * The Zoho TASK custom-field API name for the provision-ticket URL. Defaults to
 * "provision" (the confirmed api name) so the feature is ON by default; an env
 * override is allowed only for parity with the other field-name helpers. Unlike
 * CompanyCam this NEVER returns null — the field name is always resolvable, and
 * tolerance for the field not yet existing in Zoho is handled at the write site
 * (best-effort setTaskFields) and the read site (provisionFromTask -> "").
 */
export function provisionFieldName(env: Env): string {
  return env.ZOHO_PROVISION_FIELD?.trim() || "provision";
}

/** The WO-TYPE pick-list custom-field API name (Service WO / Production WO / Prewire WO). Default "wo_type". */
export function woTypeFieldName(env: Env): string {
  return env.ZOHO_WO_TYPE_FIELD?.trim() || "wo_type";
}

// ---------------------------------------------------------------------------
// WO status lives IN Zoho (2026-09-09). Three pick-list custom fields on the SERVICE task
// layout, created by Craig. Option strings must match Zoho EXACTLY (a mismatched write is
// silently rejected by the pick-list — see the 2026-08-25 "Waiting Payment" incident).
// ---------------------------------------------------------------------------

/** "Work Order Task Status" pick-list (Pending | Completed) on the Work Order Tasks task, its subtasks, and the Billing task. */
export function woTaskStatusFieldName(env: Env): string {
  return env.ZOHO_WO_TASK_STATUS_FIELD?.trim() || "wo_task_status";
}
export const TASK_STATUS_PENDING = "Pending";
export const TASK_STATUS_COMPLETED = "Completed";
export const TASK_STATUSES = [TASK_STATUS_PENDING, TASK_STATUS_COMPLETED] as const;

/** "Billing Status" pick-list (Billable | Non-Billable | Internal) on the Billing task. Replaces the KV billable flag. */
export function billingStatusFieldName(env: Env): string {
  return env.ZOHO_BILLING_STATUS_FIELD?.trim() || "billing_status";
}
export const BILLING_STATUSES = ["Billable", "Non-Billable", "Internal"] as const;
export const DEFAULT_BILLING_STATUS = "Billable";

/** "Work Order Status" pick-list (`wo_cycle_status`) on the per-WO "Work Order Status" task — the authoritative WO status. */
export function woCycleStatusFieldName(env: Env): string {
  return env.ZOHO_WO_CYCLE_STATUS_FIELD?.trim() || "wo_cycle_status";
}

/**
 * The status a to-do gets when it is first created. Passed straight through to Zoho's
 * `to_do_s` pick-list (Open | Awaiting Feedback | On-Hold | Completed); "Open" is the
 * default. NOT enforced — Zoho validates its own pick-list (mirrors DEFAULT_ORDER_STATUS).
 */
export const DEFAULT_TODO_STATUS = "Open";

/**
 * The task pick-list custom-field API name that stores a to-do's status. Default "to_do_s"
 * (UNDERSCORE — confirmed live on the WO 0026 payload: `"to_do_s":"Open"`; the earlier
 * hyphen `to_do-s` was wrong and read the wrong key). Status is pass-through only; the todo
 * discriminator is the `fhi-todo-v1:` description token, so this field's default value on
 * every task no longer matters for type detection.
 */
export function todoStatusFieldName(env: Env): string {
  return env.ZOHO_TODO_STATUS_FIELD?.trim() || "to_do_s";
}

/** WO sequence scope: one global portal-wide yearly counter, or per-project. */
export type SequenceScope = "global" | "per_project";
export function sequenceScope(env: Env): SequenceScope {
  return env.WO_SEQUENCE_SCOPE === "per_project" ? "per_project" : "global";
}

/** How to identify SERVICE projects when listing. */
export interface ServiceMatch {
  mode: "name_suffix" | "tag" | "group";
  value: string;
}
export function serviceMatch(env: Env): ServiceMatch {
  const mode = (env.ZOHO_SERVICE_MATCH_MODE as ServiceMatch["mode"]) || "name_suffix";
  // Default: project names end in "- SERVICE" (per the spec's naming convention).
  const value = env.ZOHO_SERVICE_MATCH_VALUE || "SERVICE";
  return { mode, value };
}

/** Google auth method selector. */
export type GoogleAuthMethod = "service_account" | "oauth_user";
export function googleAuthMethod(env: Env): GoogleAuthMethod {
  return env.GOOGLE_AUTH_METHOD === "oauth_user" ? "oauth_user" : "service_account";
}

/**
 * The PIN that gates the /admin config endpoints. Reads env `ADMIN_PIN`, falling
 * back to "3825". Can be promoted to a secret later without touching callers.
 */
export function adminPin(env: Env): string {
  return env.ADMIN_PIN || "3825";
}

/** Typed error so the router can map config problems to HTTP 501/400 cleanly. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
