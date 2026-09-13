//==============================================================================
// Shared domain + wire types for the FHI Service Work Order backend.
//==============================================================================

/** Cloudflare Worker bindings + env vars. Mirrors wrangler.toml + .dev.vars.example. */
export interface Env {
  // --- Bindings ---
  WO_KV: KVNamespace;
  /** Hyperdrive → Supabase Postgres (genesis-db). See src/db.ts. */
  HYPERDRIVE?: Hyperdrive;
  /** R2 bucket `genesis-files` (plan images / photos / PDFs). Wired at a later row. */
  FILES?: R2Bucket;

  // --- Database / tenancy (F2) ---
  /**
   * TEST/DEV ONLY fallback used by src/db.ts when the HYPERDRIVE binding is absent
   * (vitest against a local Postgres, or `.dev.vars`). Never set in production —
   * the Worker must go through Hyperdrive.
   */
  DATABASE_URL?: string;
  /** The tenant this deployment serves (single-tenant for now). FHI = f4100000-0000-4000-8000-000000000001. */
  TENANT_ID?: string;
  /** "true" lets an `X-Tenant-Id` request header override TENANT_ID. Dev/test only; never set in prod. */
  ALLOW_TENANT_HEADER?: string;
  /** Shared secret for POST /internal/events/fanout (header X-Internal-Token). SECRET. */
  INTERNAL_TOKEN?: string;

  // --- Zoho ---
  ZOHO_REFRESH_TOKEN: string;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_PORTAL_ID: string;
  ZOHO_API_BASE: string;
  ZOHO_ACCOUNTS_BASE: string;
  /** Task custom-field API name that stores the full composite WO string. UNKNOWN — see config.ts. */
  ZOHO_WO_FIELD: string;
  ZOHO_SERVICE_MATCH_MODE?: string; // name_suffix | tag | group
  ZOHO_SERVICE_MATCH_VALUE?: string;
  ZOHO_TASKLIST_FLAG?: string;
  ZOHO_STATUS_OPEN_ID?: string;
  /**
   * Status ids for the PURCHASING project (FHI-907), whose task-status workflow is
   * SEPARATE from the service projects'. Used to actually close/reopen a purchasing
   * task when its order_status crosses the DONE line. When unset, the backend falls
   * back to the top-level `is_completed` boolean (no cross-project status id is used).
   */
  ZOHO_PURCHASING_STATUS_OPEN_ID?: string;
  ZOHO_PURCHASING_STATUS_CLOSED_ID?: string;
  ZOHO_STATUS_CLOSED_ID?: string;
  // Task custom fields that mirror the schedule for Zoho-native filtering/dashboards.
  ZOHO_VISITS_FIELD?: string;      // default "wo_schedule" (multi-line text; visit data)
  ZOHO_NEXTVISIT_FIELD?: string;   // default "wo_date_time" (date-time; next visit)
  ZOHO_SCHEDSTATUS_FIELD?: string; // default "wo_schedule_status" (pick-list; status label)
  ZOHO_USED_ITEMS_FIELD?: string;  // default "wo_used_items" (plain text; JSON array of used items)
  /** Project custom-field API name for the client's support membership level. Default "support_membership_actual". */
  ZOHO_MEMBERSHIP_FIELD?: string;
  /** Task custom-field API name for the CompanyCam URL. NO DEFAULT — unset = feature off (no reads/writes). */
  ZOHO_COMPANYCAM_FIELD?: string;
  /** Task custom-field API name for the WO type pick-list. Defaults to "wo_type". */
  ZOHO_WO_TYPE_FIELD?: string;
  /** Pick-list field names for the Zoho-native WO status model (2026-09-09). Defaults: wo_task_status / billing_status / wo_cycle_status. */
  ZOHO_WO_TASK_STATUS_FIELD?: string;
  ZOHO_BILLING_STATUS_FIELD?: string;
  ZOHO_WO_CYCLE_STATUS_FIELD?: string;
  /** Task custom-field API name for the provision-ticket URL. Defaults to "provision" (the confirmed api name). */
  ZOHO_PROVISION_FIELD?: string;
  /**
   * Task pick-list custom-field API name that stores a to-do subtask's STATUS. Default
   * "to_do-s". Values (pass-through, NOT hard-validated — Zoho owns its pick-list): Open |
   * Awaiting Feedback | On-Hold | Completed. Default on create = "Open"; "Completed" archives.
   */
  ZOHO_TODO_STATUS_FIELD?: string;

  // --- Purchasing (parts request -> purchasing dashboard) ---
  /** The Zoho PROJECT id of the FHI-907 purchasing project (a project, not a SERVICE ticket). */
  ZOHO_PURCHASING_PROJECT_ID?: string;
  /** Pick-list custom-field API name on purchasing tasks. Default "order_status". */
  ZOHO_ORDER_STATUS_FIELD?: string;
  /**
   * Comma-separated order_status labels that count a requested part as DONE. This ONE
   * set both (a) clears the WO-completion gate (blocks moving a WO to billing/completed
   * while it still has requested parts in any OTHER status) and (b) archives the item
   * (its Zoho task is completed, dropping it off the active purchasing list; moving it
   * back to a non-done status un-archives it). Default "Installed,Not Needed,Cancelled".
   * Must match the exact Zoho order_status option labels.
   */
  ZOHO_ORDER_RESOLVED_STATUSES?: string;
  /**
   * order_status labels meaning a part was physically INSTALLED (comma-separated). Both
   * redesigned variants — "Installed (From Stock)", "Installed (Field Purchase)" — plus
   * legacy "Installed" by default. The older singular ZOHO_ORDER_INSTALLED_STATUS is
   * still honored as a fallback.
   */
  ZOHO_ORDER_INSTALLED_STATUSES?: string;
  /** @deprecated single-label fallback for ZOHO_ORDER_INSTALLED_STATUSES. */
  ZOHO_ORDER_INSTALLED_STATUS?: string;

  // --- Zoho Cliq (best-effort notifications; SECRETS via `wrangler secret put`) ---
  /** Webhook for the materials/parts channel (part-request posts). Optional. */
  CLIQ_MATERIALS_WEBHOOK?: string;
  /** Webhook for the daily-digest channel. Optional (reserved for a daily poster). */
  CLIQ_DAILY_WEBHOOK?: string;
  /** Zoho Cliq #Scheduling channel webhook — tentative-appointment notices. SECRET. */
  CLIQ_SCHEDULING_WEBHOOK?: string;
  /** Zoho Cliq webhook for action-item reminders. Optional; falls back to CLIQ_SCHEDULING_WEBHOOK. SECRET. */
  CLIQ_REMINDERS_WEBHOOK?: string;
  /** Zoho Cliq webhook for the dedicated Action Items channel (assign/reassign notifications).
   *  Optional; falls back to CLIQ_REMINDERS_WEBHOOK then CLIQ_SCHEDULING_WEBHOOK. SECRET. */
  CLIQ_ACTIONITEMS_WEBHOOK?: string;

  // --- Google Calendar ---
  GOOGLE_AUTH_METHOD: string; // service_account | oauth_user
  GOOGLE_CALENDAR_BASE: string;
  GOOGLE_TOKEN_URI: string;
  DEFAULT_CALENDAR_ID: string;
  // Service-account method
  GOOGLE_SA_CLIENT_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string;
  GOOGLE_SA_SUBJECT?: string;
  // Shared-OAuth-user method
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REFRESH_TOKEN?: string;

  // --- AI (invoice-notes polish via the Anthropic Messages API) ---
  /** Anthropic API key for the invoice-notes endpoint. SECRET (`wrangler secret put ANTHROPIC_API_KEY`). */
  ANTHROPIC_API_KEY?: string;
  /** Anthropic model for invoice-notes. Default "claude-haiku-4-5-20251001". */
  AI_MODEL?: string;

  // --- App ---
  APP_ORIGIN: string;
  /** Optional template for the "open this WO" link put into calendar events.
   *  {id} = WO id (actionTaskId), {wo} = full WO number. Defaults to
   *  `<first APP_ORIGIN>/work-orders/{id}`. */
  APP_WO_URL_TEMPLATE?: string;
  /** Public URL of THIS deployed Worker, used to build daily-report PDF links
   *  (the PDF is served by the Worker, so the link must point back at it). If
   *  unset, sendDailyReport returns a null pdfUrl. Set in wrangler.toml [vars]. */
  PUBLIC_WORKER_URL?: string;
  WO_SEQUENCE_SCOPE: string; // global | per_project
  /** Optional: once /setup has stored creds, reconfiguring requires this token. */
  SETUP_TOKEN?: string;
  /** PIN gating the /admin config endpoints. Defaults to "3825" — see config.ts adminPin(). */
  ADMIN_PIN?: string;
}

/**
 * PIN-gated admin config stored in KV under `admin:config`. Extensible: for now
 * it only carries the list of users allowed to generate reports, but new fields
 * can be added over time. craig@fhiflorida.com is always present in reportAccess.
 */
export interface AdminConfig {
  reportAccess: string[];
  /**
   * App-maintained list of the allowed Zoho PROJECTS "users" pick-list VALUES. The
   * app does NOT read or write that Zoho field — this is a local, reference-only
   * mirror of its options, used to populate the People "Zoho user" dropdown. Trimmed,
   * non-empty, de-duplicated (order preserved); defaults to [].
   */
  zohoUserOptions: string[];
  /** Who is @-tagged in the #Scheduling Cliq post AND assigned the "confirm appointment" to-do. Default "Angie Hartman". */
  schedulingConfirmer?: string;
}

/** Derived work-order lifecycle status (never stored — computed from the two tasks). */
export type WorkOrderStatus = "action" | "billing" | "completed";

/**
 * The redesigned 7-state WO status (2026-08-23), stored/mirrored in the
 * `wo_schedule_status` pick-list. Hybrid: the first three are auto-derived from the
 * calendar; the back four are set manually and "stick".
 */
export type WoStatus =
  | "Not Scheduled"
  | "Scheduled"
  | "Needs Rescheduled"
  | "On Hold"
  | "Ready for Billing"
  | "Waiting Payment"
  | "Completed";

/** Derived scheduling status (never stored — computed from visits + lifecycle + now). */
export type ScheduleStatus = "unscheduled" | "scheduled" | "needs_reschedule";

/** Board filter chips. */
export type WorkOrderFilter = "active" | "billing" | "done" | "all";

/** Sort options for the list board. */
export type WorkOrderSort = "newest" | "oldest" | "client" | "priority";

/** The three site access codes, which live on the Zoho PROJECT (not the task). */
export interface AccessCodes {
  gate_code: string | null;       // resident gate
  community_gate: string | null;  // community gate
  door_code: string | null;       // door code
}

/** Scheduling info tying a WO to a single Google Calendar event. */
export interface Schedule {
  calendarId: string;            // which calendar the event lives on
  eventId: string | null;        // Google event id (stored on the WO)
  start: string | null;          // ISO 8601
  end: string | null;            // ISO 8601
  attendees: string[];           // tech emails invited as GUESTS (one event, many guests)
  htmlLink?: string | null;      // Google event link
}

/**
 * A single scheduled visit for a work order. A WO can have several (multi-day
 * jobs, return trips); each visit is its OWN Google Calendar event with the
 * assigned techs as guests. The full list is stored in the Action task
 * description (visits trailer) and surfaced on the WorkOrder.
 */
export interface Visit {
  id: string;                 // crypto.randomUUID()
  start: string | null;       // ISO 8601
  end: string | null;         // ISO 8601
  attendees: string[];        // tech emails invited as guests
  label: string | null;       // optional, e.g. "Day 1", "Return for part"
  calendarId: string;         // defaults to DEFAULT_CALENDAR_ID
  eventId: string | null;     // Google event id
  htmlLink: string | null;
  /** Confirmation state — false = TENTATIVE (bold TENTATIVE in the Google event); absent/true = confirmed. */
  confirmed?: boolean;
  /** Id of the auto "confirm this appointment" to-do (assigned to the scheduling confirmer); resolved on confirm. */
  confirmTodoId?: string | null;
  /** True when this is a REMOTE support appointment (vs an on-site visit). */
  remote?: boolean;
}

/**
 * A single material/part used on a work order. The list is serialized as raw JSON
 * into the wo_used_items plain-text task custom field, so it stays with the WO.
 */
export interface UsedItem {
  id: string;
  item: string;
  quantity: number | null;
  note: string | null;
  at: string;            // ISO 8601 — when it was recorded
  by: string | null;     // who recorded it (tech email / name), optional
  /**
   * Whether the item was actually installed on the job. A tech confirms this before
   * the ticket is closed for billing. Manual adds default false; a used item
   * auto-created from an Installed part is created with installed:true.
   */
  installed: boolean;
  /**
   * How this used item came to exist: "manual" (a tech added it directly) or "part"
   * (auto-created when a requested purchasing part was marked Installed).
   */
  source: "manual" | "part";
  /**
   * The purchasing item (Zoho purchasing task) id when this used item was created
   * from an installed part — the dedupe key so toggling the part status repeatedly
   * updates the same row rather than adding duplicates. null for manual items.
   */
  sourcePartId: string | null;
}

/** Body for POST /work-orders/:id/used-items — add one used item. */
export interface AddUsedItemInput {
  item: string;
  quantity?: number;
  note?: string;
  by?: string;
}

/**
 * Body for PATCH /work-orders/:id/used-items/:itemId — mark a used item
 * installed / edit it. Every field optional; only supplied ones apply.
 */
export interface PatchUsedItemInput {
  installed?: boolean;
  quantity?: number;
  note?: string;
}

//------------------------------------------------------------------------------
// Purchasing dashboard — parts requested from a WO become tasks in the FHI-907
// purchasing project; the purchasing team drives them through order statuses.
//------------------------------------------------------------------------------

/**
 * The pick-list order_status values, exactly as configured in Zoho (7 labels;
 * "Installed" re-added by Craig, 2026-08-22). DONE statuses (Installed / Not Needed /
 * Cancelled) both clear the WO-completion gate and archive the item.
 *
 * NOTE: this type is kept for documentation/autocomplete ONLY. The backend does
 * NOT enforce it at runtime — status values are passed straight through to Zoho,
 * which is the authoritative validator of its own pick-list (see index.ts
 * validateUpdatePurchase + the GET /purchasing filter). Craig has renamed these
 * labels twice; making the backend the gatekeeper was a fragility, so unknown
 * strings now flow through instead of being rejected.
 */
export type OrderStatus =
  // redesigned 7 (2026-08-23):
  | "Needed"
  | "On Order"
  | "Staged"
  | "Backordered"
  | "Installed (From Stock)"
  | "Installed (Field Purchase)"
  | "Cancelled"
  // legacy labels, kept for back-compat until migration re-tags old data:
  | "Not Needed"
  | "Received"
  | "Installed";

/** One item on the purchasing dashboard (a task in the FHI-907 purchasing project). */
export interface PurchaseItem {
  id: string;            // the purchasing task id
  item: string;          // task name
  quantity: number | null;
  note: string | null;
  status: string;        // from order_status — whatever Zoho returns (not constrained to OrderStatus)
  sourceWo: string | null;   // work_order_hash on the purchasing task (source WO reference)
  sourceWoId: string | null; // the source WO's actionTaskId (so the UI can deep-link), stored too
  /**
   * True when the item's Zoho task is completed/closed (sourced from the task's
   * is_closed_type / is_completed / completed detection). An item reaching a DONE
   * status (Installed / Not Needed / Cancelled) is completed in Zoho -> archived:
   * dropped from the active purchasing list but still viewable, never deleted.
   */
  archived: boolean;
  createdAt: string | null;
}

/** Body for POST /work-orders/:id/requested-items — request a part from a WO. */
export interface RequestItemInput {
  item: string;
  quantity?: number;
  note?: string;
}

/**
 * Body for POST /work-orders/:id/items — add an item to a WO (unified Items model).
 * Like RequestItemInput but with an optional initial `status` (default "Needed"); a
 * tech logging something already used passes e.g. "Installed (From Stock)".
 */
export interface AddItemInput {
  item: string;
  quantity?: number;
  note?: string;
  status?: string;
}

/**
 * A unified Item = a purchasing task linked to a WO. "Requested" and "Used" are just
 * views of this one record by status. Same shape as PurchaseItem (the purchasing store
 * IS the item store); kept as an alias so new code reads clearly.
 */
export type Item = PurchaseItem;

/** Body for PATCH /purchasing/:itemId — update a purchasing item. */
export interface UpdatePurchaseInput {
  /**
   * Order status. Any non-empty string is accepted at the boundary and passed
   * straight through to Zoho (which validates against its own pick-list). See
   * OrderStatus for the CURRENT expected values, but the backend does not enforce them.
   */
  status?: string;
  note?: string;
  quantity?: number;
}

/** Body for POST /work-orders/:id/hours — log time against the WO (stored in KV). */
export interface LogHoursInput {
  hours: number;         // hours to log (positive)
  techEmail?: string;    // optional tech attribution (email)
  note?: string;
  date?: string;         // ISO 8601 / YYYY-MM-DD; defaults to now
}

//------------------------------------------------------------------------------
// To-Dos / action items — every WO gets a per-WO "To-Dos" task (auto-created like
// the Daily Report task); each todo is a SUBTASK under it. The status lives in the
// `to_do-s` pick-list custom field; URGENCY reuses Zoho's native task priority; the
// ASSIGNEE is backend-managed and stashed in the subtask description as a plain-text
// token (fhi-todo-v1:<b64url>) that survives Zoho's rich-text sanitization — mirrors
// the visits token technique. "Completed" status archives the todo (its subtask is
// closed); any other status reopens it.
//------------------------------------------------------------------------------

/** One to-do / action item on a work order (a subtask under the WO's "To-Dos" task). */
export interface Todo {
  id: string;                    // the todo subtask id
  title: string;                 // task name
  /**
   * Status from the `to_do-s` pick-list — whatever Zoho returns (Open | Awaiting Feedback
   * | On-Hold | Completed), not constrained/validated by the backend. Default "Open".
   */
  status: string;
  /** URGENCY = Zoho's native task priority (none|low|medium|high); null when unset. */
  urgency: string | null;
  /** Backend-managed assignee (free text), parsed from the description token. Null when unset. */
  assignee: string | null;
  /** Human notes (the description with the assignee token + "Assigned:" line stripped). */
  notes: string | null;
  /** The owning WO's stable id (actionTaskId), recovered from the token; null if unknown. */
  workOrderId: string;
  /** The owning WO's composite number (from work_order_hash), for the dashboard deep-link. */
  workOrderNumber: string | null;
  /** True when the todo's subtask is completed/closed (status reached "Completed"). */
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * A MATERIAL on a work order — a subtask under the WO's "Materials" holder task. Added
 * manually, or auto-created when an item is requested via Item Request (fromRequest=true,
 * sourceItem = the requested item text). Simple check-to-complete subtask, like the others.
 */
export interface Material {
  id: string;
  name: string;
  notes: string | null;
  /** True when auto-added from an Item Request event (vs. entered manually). */
  fromRequest: boolean;
  /** The requested item text this material came from, when fromRequest; null otherwise. */
  sourceItem: string | null;
  /** The source Item's id (the Item Request subtask), when fromRequest — lets the UI show that
   *  item's live status on the material line. Null for manually-added materials. */
  sourceItemId: string | null;
  completed: boolean;
  /** The owning WO's stable id (actionTaskId), recovered from the token. */
  workOrderId: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Body for POST /work-orders/:id/materials — add a material to a WO (manual). */
export interface CreateMaterialInput {
  name: string;
  notes?: string;
}

/** Body for PATCH /work-orders/:id/materials/:mid — only supplied fields apply. */
export interface UpdateMaterialInput {
  completed?: boolean;
  name?: string;
  notes?: string;
}

/** Body for POST /work-orders/:id/todos — add a to-do to a WO. */
export interface CreateTodoInput {
  title: string;
  /** Initial `to_do-s` status; default "Open". Pass-through (not validated). */
  status?: string;
  /** URGENCY = native task priority (none|low|medium|high). */
  priority?: string;
  /** Assignee (free text; populated from the people registry choices, not validated against it). */
  assignee?: string;
  notes?: string;
}

/** Body for PATCH /work-orders/:id/todos/:todoId — every field optional; only supplied ones apply. */
export interface UpdateTodoInput {
  title?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  notes?: string;
}

/** One of the ticket's two main tasks (the work task + the billing task). */
export interface WorkOrderTask {
  id: string;
  name: string;
  isCompleted: boolean;
  kind: "work" | "billing";
  /** Zoho `wo_task_status` pick-list value (Pending | Completed). Falls back to the native open/closed flag when the field is unset (pre-migration). */
  taskStatus: string;
}

/** A fully-hydrated work-order record returned by the API. */
export interface WorkOrder {
  /** Stable id used in routes: the Zoho Action task id. */
  id: string;
  /** Full composite reference, e.g. FHI-672-WO-2026-0001. */
  workOrderNumber: string;
  /** Project key portion, e.g. FHI-672. */
  projectKey: string;
  /** Minted portion, e.g. 2026-0001. */
  mintedRef: string;

  projectId: string;
  projectName: string;
  client: string;
  siteAddress: string | null;
  /** Client support membership level from the PROJECT (support_membership_actual). Null on the light LIST path. */
  membershipLevel: string | null;
  subject: string;        // ticket / task-list name
  /** CompanyCam URL from the Action task's ZOHO_COMPANYCAM_FIELD. Null when unset or the field is unconfigured. */
  companyCamUrl: string | null;
  /**
   * Provision-ticket URL from the Action task's `provision` custom field. Always a
   * string ("" when unset, or while the Zoho field doesn't exist yet) so the
   * front-end header can render (or hide) the link without a null check.
   */
  provision: string;
  /** WO type from the `wo_type` pick-list (Service WO / Production WO / Prewire WO); "" when unset. */
  woType: string;
  /** Back-compat boolean: true iff billingStatus === "Billable". (Was a KV flag before 2026-09-09.) */
  billable?: boolean;
  /** Zoho `billing_status` pick-list on the Billing task: Billable | Non-Billable | Internal. */
  billingStatus: string;
  /** The per-WO "Work Order Status" task id (carries `wo_cycle_status`). Null until migrated/lazily created. */
  statusTaskId: string | null;
  /** The raw `wo_cycle_status` value as stored in Zoho ("" when unset / no Status task). Diagnostic; `woStatus` is the effective value. */
  cycleStatusRaw: string;

  status: WorkOrderStatus;
  /** Derived scheduling status (never stored — from visits + lifecycle + now). */
  scheduleStatus: ScheduleStatus;
  /**
   * The WO status (2026-09-09: stored in Zoho as `wo_cycle_status` on the WO's "Work Order
   * Status" task). Not Scheduled / Scheduled / Needs Reschedule are auto (calendar-derived);
   * On Hold / Active Monitoring / Ready for Billing / Waiting Payment / Closed are manual +
   * sticky. Legacy "Completed" reads as Closed. Back-compat: `status` is still returned.
   */
  woStatus: string;
  priority: string | null;

  taskListId: string;
  actionTaskId: string;
  billingTaskId: string | null;
  /**
   * The per-WO "Daily Report" task id (auto-created in the ticket's task list).
   * Daily reports are recorded as dated subtasks under it. Null for older WOs
   * created before this feature (or on the light LIST path, which doesn't hydrate it).
   */
  dailyReportTaskId: string | null;
  /**
   * The per-WO "To-Dos" task id (auto-created in the ticket's task list; each todo is a
   * subtask under it). Null for older WOs created before this feature (or on the light
   * LIST path). Lazily created when the first todo is added to a pre-feature WO.
   */
  todoTaskId: string | null;
  /** The ticket's two main tasks, for the app to display (work checklist lives under the work task). */
  tasks: WorkOrderTask[];

  notes: string | null;   // Action task description
  accessCodes: AccessCodes;
  /** Summary of the FIRST (earliest by start) visit — kept for back-compat. */
  schedule: Schedule;
  /** All scheduled visits (multi-day jobs / return trips), each its own event. */
  visits: Visit[];
  /** Materials/parts used on this WO (stored as JSON in the wo_used_items task field). */
  usedItems: UsedItem[];
  /**
   * The WO's to-dos / action items (subtasks under the "To-Dos" task). Populated on the
   * DETAIL path only (excludes archived); always [] on the fast board LIST path.
   */
  todos: Todo[];
  /**
   * Time logged against the WO, self-managed in KV (Zoho Projects v3 has no task
   * time-log endpoint). `total` is the summed hours; `entries` is the per-log list.
   */
  hours: {
    total: number;
    entries: Array<{ tech: string | null; hours: number; at: string; note: string | null }>;
  };
  /** Set when the WO was created OK but the calendar event failed (e.g. Google not connected). */
  scheduleError?: string | null;

  createdAt: string | null;
  updatedAt: string | null;
}

/** Body for POST /work-orders. */
export interface CreateWorkOrderInput {
  projectId: string;              // Zoho project id of the client SERVICE project
  subject: string;                // ticket name (becomes task-list + task names)
  notes?: string;                 // initial Action task description (link/instructions)
  priority?: string;
  steps?: string[];               // subtasks of the Action task
  schedule?: {
    calendarId?: string;          // defaults to DEFAULT_CALENDAR_ID
    start: string;                // ISO 8601
    end: string;                  // ISO 8601
    attendees?: string[];         // tech emails to invite as guests (raw emails)
    pending?: boolean;            // create the first visit as TENTATIVE (needs confirmation)
    notifyConfirmer?: boolean;    // when TENTATIVE, also ping the scheduler in Cliq + add a confirm to-do (default OFF)
    remote?: boolean;             // mark the first visit as a REMOTE support appointment
  };
  /** Preferred way to invite techs: ids from the Technicians registry, resolved to emails server-side. */
  technicianIds?: string[];
  accessCodes?: Partial<AccessCodes>; // optional overrides written back to the project
  /** Optional CompanyCam URL; written to the Action task when the field is configured. */
  companyCamUrl?: string;
  /** Optional provision-ticket URL; persisted to the Action task's `provision` custom field. */
  provision?: string;
  woType?: string;
  /** Legacy boolean; mapped to billingStatus (true → Billable, false → Non-Billable) when billingStatus is absent. */
  billable?: boolean;
  /** Billable | Non-Billable | Internal (default Billable). Written to the Billing task's `billing_status`. */
  billingStatus?: string;
}

/** Body for PATCH /work-orders/:id — every field optional; only supplied ones apply. */
export interface UpdateWorkOrderInput {
  notes?: string;
  priority?: string;
  status?: WorkOrderStatus;       // legacy 3-state; maps to opening/closing the Action/Billing tasks
  /**
   * Redesigned 7-state WO status. Takes precedence over `status` when both are sent.
   * Scheduling values (Not Scheduled / Scheduled / Needs Rescheduled) return the WO to
   * the active/auto phase; On Hold pauses; Ready for Billing / Waiting Payment / Completed
   * are the closing states (Ready for Billing + beyond run the items completion gate).
   */
  woStatus?: string;
  accessCodes?: Partial<AccessCodes>; // writes back to the PROJECT
  schedule?: {
    calendarId?: string;
    start?: string;
    end?: string;
    attendees?: string[];
  };
  /** CompanyCam URL; written to the Action task when the field is configured. Empty string clears it. */
  companyCamUrl?: string;
  /**
   * Provision-ticket URL; written to the Action task's `provision` custom field.
   * Empty string CLEARS it; ABSENT from the body leaves the stored value unchanged.
   */
  provision?: string;
  woType?: string;
  /** Legacy boolean toggle; mapped to billingStatus when billingStatus is absent. */
  billable?: boolean;
  /** Billable | Non-Billable | Internal → the Billing task's `billing_status`. */
  billingStatus?: string;
}

/** Body for PATCH /work-orders/:id/tasks/:taskId — set a work task / subtask / Billing task's wo_task_status. */
export interface SetTaskStatusInput {
  taskStatus: string; // Pending | Completed
}

/** Result of the auto-promotion check run after a task-status write or on a detail read. */
export interface TaskStatusResult {
  workOrder: WorkOrder;
  /** True when this write auto-moved the WO to Ready for Billing. */
  autoPromoted: boolean;
  /** Set when the auto-move was blocked by the items completion gate (WO left unchanged). */
  gateMessage: string | null;
}

/** Body for POST /work-orders/:id/visits — add a new visit (its own event). */
export interface AddVisitInput {
  start: string;                // ISO 8601
  end: string;                  // ISO 8601
  attendees?: string[];         // tech emails to invite as guests
  label?: string;               // optional, e.g. "Day 1"
  calendarId?: string;          // defaults to DEFAULT_CALENDAR_ID
  /** When true, create as TENTATIVE: bold TENTATIVE in the Google event (in-app confirm). */
  pending?: boolean;
  /** When true AND tentative, ping the scheduler in Cliq + add a confirm to-do (default OFF). */
  notifyConfirmer?: boolean;
  /** When true, mark this as a REMOTE support appointment. */
  remote?: boolean;
}

/** Body for PATCH /work-orders/:id/visits/:visitId — every field optional. */
export interface UpdateVisitInput {
  start?: string;
  end?: string;
  attendees?: string[];
  label?: string;
  calendarId?: string;
  remote?: boolean;
}

//------------------------------------------------------------------------------
// Daily reports — a technician adds dated notes to a WO over the day; "send"
// compiles the day's entries into a PDF (served by the Worker), records a dated
// subtask in Zoho, and posts a digest to Cliq. Entries + PDF + sent-marker live
// in KV (same rationale as hours: a self-managed running log that must be reliable).
//------------------------------------------------------------------------------

/** One daily-report note appended to a WO's running log for a given day. */
export interface DailyReportEntry {
  tech: string | null;   // tech email / name, optional
  text: string;          // the note body
  at: string;            // ISO 8601 — when it was appended
}

/** A day's daily report as returned by GET /work-orders/:id/daily-report. */
export interface DailyReportDay {
  date: string;                 // YYYY-MM-DD
  entries: DailyReportEntry[];
  sent: boolean;                // has this day's report been compiled + distributed?
  pdfUrl: string | null;        // Worker-served PDF link (null until sent / if unset)
}

/** Body for POST /work-orders/:id/daily-report/entries — append one entry. */
export interface AddDailyReportEntryInput {
  text: string;          // required
  tech?: string;         // optional attribution
  date?: string;         // YYYY-MM-DD; defaults to today (Eastern Time)
}

/** Result of the calendar reconcile. */
export interface SyncResult {
  scanned: number;
  reconciled: number;
  conflicts: number;
  details: Array<{ workOrderNumber: string; action: string }>;
}
