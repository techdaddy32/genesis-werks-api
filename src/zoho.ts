//==============================================================================
// zoho.ts — Zoho Projects (v3) client.
//
// Responsibilities:
//   - OAuth access-token refresh with an in-memory cache (refresh token never expires).
//   - List SERVICE projects (by name suffix / tag / group — configurable).
//   - Read a project's access-code custom fields (gate_code, community_gate, door_code).
//   - Create a ticket task-list, the Action + Billing tasks, and Action subtasks (steps).
//   - Set the WO# task custom field (field name read from config in ONE place).
//   - Set/get a task's description (the "notes" field).
//   - Update task status (open/close).
//   - Get tasks for a project (for listing / status derivation).
//
// NOTE ON ENDPOINTS: Zoho's Projects v3 surface is versioned and some field/param
// names differ across portals. Every place a shape is uncertain is marked
// TODO(craig) and kept in one spot so it's cheap to correct against the live API
// (this environment has no egress, so nothing here was validated live).
//==============================================================================

import type { Env, AccessCodes } from "./types";
import {
  woFieldName,
  assertWoFieldConfigured,
  serviceMatch,
  purchasingProjectId,
  assertPurchasingConfigured,
  orderStatusFieldName,
  DEFAULT_ORDER_STATUS,
} from "./config";
import { getZohoCreds } from "./creds";

//------------------------------------------------------------------------------
// Token cache (in-memory, per-isolate). A Worker isolate is short-lived, so this
// simply avoids refreshing on every call within the same isolate's lifetime.
//------------------------------------------------------------------------------
interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}
let tokenCache: CachedToken | null = null;
const TOKEN_SKEW_MS = 60_000; // refresh a minute early to avoid edge expiry

/** Get a valid Zoho access token, refreshing (and caching) when needed. */
export async function getAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_SKEW_MS > now) {
    return tokenCache.accessToken;
  }

  // Credentials come from integration_credentials (written by /setup) first, then env secrets.
  const creds = await getZohoCreds(env);
  if (!creds) {
    throw new ZohoError("Zoho is not configured yet — open /setup to connect it.");
  }

  const url =
    `${env.ZOHO_ACCOUNTS_BASE}/oauth/v2/token` +
    `?refresh_token=${encodeURIComponent(creds.refreshToken)}` +
    `&client_id=${encodeURIComponent(creds.clientId)}` +
    `&client_secret=${encodeURIComponent(creds.clientSecret)}` +
    `&grant_type=refresh_token`;

  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new ZohoError(`Zoho token refresh failed: ${res.status} ${await safeText(res)}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!body.access_token) {
    throw new ZohoError(`Zoho token refresh returned no access_token: ${JSON.stringify(body)}`);
  }
  // expires_in is seconds (typically 3600).
  const ttlMs = (body.expires_in ?? 3600) * 1000;
  tokenCache = { accessToken: body.access_token, expiresAt: now + ttlMs };
  return body.access_token;
}

/** Test seam: clear the cache (used by tests / forced refresh). */
export function _clearTokenCache(): void {
  tokenCache = null;
}

//------------------------------------------------------------------------------
// Low-level request helper.
//------------------------------------------------------------------------------
async function zohoFetch(
  env: Env,
  path: string,
  init: RequestInit & { query?: Record<string, string | number | undefined> } = {}
): Promise<any> {
  const token = await getAccessToken(env);
  const { query, headers, ...rest } = init;

  let url = `${env.ZOHO_API_BASE}${path}`;
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }

  const res = await fetch(url, {
    ...rest,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: "application/json",
      ...headers,
    },
  });

  if (!res.ok) {
    throw zohoFailure(`Zoho ${rest.method ?? "GET"} ${path} failed`, res.status, await safeText(res));
  }
  // Some Zoho endpoints return empty bodies on success (e.g. updates).
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const portal = (env: Env) => env.ZOHO_PORTAL_ID;

//------------------------------------------------------------------------------
// Normalized shapes returned to the rest of the app.
//------------------------------------------------------------------------------
export interface ZohoProject {
  id: string;
  name: string;
  key: string | null;          // e.g. FHI-672
  // Structured site-address fields entered on the Zoho project. In Projects v3 these
  // come back as TOP-LEVEL keys on the project object (same shape as the access-code
  // fields gate_code/community_gate/door_code). Read from the structured field — NOT
  // parsed out of the (inconsistent) project name.
  siteAddress: string | null;  // site_address
  siteCity: string | null;     // site_city
  siteState: string | null;    // site_state
  siteZip: string | null;      // site_zip
  openIssues: number;          // issues.open_count (Action Items) — from the v3 projects list
  closedIssues: number;        // issues.closed_count
  customFields: Record<string, string | null>;
  raw: any;
}

export interface ZohoTask {
  id: string;
  name: string;
  description: string | null;
  isCompleted: boolean;
  statusName: string | null;
  priority: string | null;
  taskListId: string | null;
  customFields: Record<string, string | null>;
  createdAt: string | null;
  updatedAt: string | null;
  raw: any;

  // --- Optional fields carried by the portal-wide task query (listPortalTasksByFilter).
  // The per-project task API doesn't always include these; they're populated when the
  // raw payload has them so a single portal query can build a WorkOrder with no fan-out.
  workOrderHash?: string | null;   // the full composite WO# (custom column `work_order_hash`)
  projectId?: string | null;       // owning project id (portal query returns project:{id,name})
  projectName?: string | null;     // owning project name
  taskListName?: string | null;    // owning task-list (ticket) name
  createdTime?: string | null;     // portal `created_time`
  lastModifiedTime?: string | null; // portal `last_modified_time`
  /** Parent task id when this is a SUBTASK (parental_info.parent_task_id). Null for top-level. */
  parentTaskId?: string | null;
}

export interface ZohoTaskList {
  id: string;
  name: string;
  isCompleted: boolean;
  raw: any;
}

//------------------------------------------------------------------------------
// Projects
//------------------------------------------------------------------------------

/**
 * List SERVICE projects. Match strategy is configurable (config.serviceMatch):
 *   - name_suffix : project name ends with the value (default "SERVICE")
 *   - tag         : project carries the given tag name
 *   - group       : project belongs to the given group id
 *
 * TODO(craig): confirm the v3 list path + the group/tag query params your portal
 * uses. The "SERVICE Project" tag / "Service Projects" group are the cleaner
 * filters if their ids are known; name-suffix is the safe default fallback.
 */
const SERVICE_PROJECTS_TTL_MS = 90_000; // rate-limit relief: the list barely changes minute-to-minute
let serviceProjectsCache: { at: number; projects: ZohoProject[] } | null = null;
/** Test seam / forced refresh. */
export function _clearServiceProjectsCache(): void {
  serviceProjectsCache = null;
}

export async function listServiceProjects(env: Env, opts: { refresh?: boolean } = {}): Promise<ZohoProject[]> {
  // Short in-memory cache (per isolate): the Action Items aggregate calls this on EVERY dashboard
  // load and it costs 2+ paginated /projects calls each time — a needless slice of the 100-per-
  // 2-minute Zoho budget (throttle hit live 2026-09-03).
  const now = Date.now();
  if (!opts.refresh && serviceProjectsCache && now - serviceProjectsCache.at < SERVICE_PROJECTS_TTL_MS) {
    return serviceProjectsCache.projects;
  }
  const projects = await listServiceProjectsUncached(env);
  serviceProjectsCache = { at: now, projects };
  return projects;
}

async function listServiceProjectsUncached(env: Env): Promise<ZohoProject[]> {
  // ROOT-CAUSE FIX (2026-09-02): this used a single classic-style `index/range` fetch and only
  // read `data.projects` — but the v3 list paginates with page/per_page (and can wrap the array
  // under `result`/`data`), so it could come back EMPTY. Its only consumer is the Action Items
  // aggregate, which then had no service projects to query → empty dashboard even though every
  // per-project /action-items call worked. Reuse the paginated, shape-robust search (same call
  // the Projects dashboard proves live) and filter to SERVICE projects.
  const all = await searchProjects(env, "");
  return all.filter((p) => isServiceProject(env, p));
}

/**
 * Search projects by name (server-side filter — not limited to the first 200).
 * Returns normalized projects; the caller decides whether to keep SERVICE-only.
 */
export async function searchProjects(env: Env, q: string, perPage = 200): Promise<ZohoProject[]> {
  const term = (q ?? "").trim();
  // v3 pagination uses page/per_page (same as the tasks endpoints). Server-side name filter.
  const filter = term
    ? JSON.stringify({
        criteria: [{ field_name: "name", criteria_condition: "contains", value: [term] }],
        pattern: "1",
      })
    : undefined;

  // ROOT-CAUSE FIX (2026-08-31): the old single-page fetch (page 1, per_page 100) silently
  // dropped every project past the first 100 — the "not all projects showing" bug. Loop pages
  // until a short (final) page or the safety cap. per_page 200 (Zoho max) → up to 5000 projects.
  const MAX_PAGES = 25;
  let projects: ZohoProject[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query: Record<string, string | number | undefined> = { page, per_page: perPage };
    if (filter) query.filter = filter;
    const data = await zohoFetch(env, `/portal/${portal(env)}/projects`, { query });

    // Be robust to the v3 projects list shape (flat `projects`/`result`, or wrapped under `data`).
    const raw: any[] =
      data?.projects ??
      data?.result ??
      data?.data?.projects ??
      data?.data?.result ??
      (Array.isArray(data) ? data : []);
    projects = projects.concat(raw.map(normalizeProject));
    if (raw.length < perPage) break; // last page reached
  }

  // Safety net: if the server ignored the filter and returned everything, narrow by name here.
  if (term) {
    const needle = term.toLowerCase();
    projects = projects.filter((p) => (p.name ?? "").toLowerCase().includes(needle));
  }
  return projects;
}

/**
 * Fetch ALL issues across the portal via the v3 portal-wide endpoint (GET /portal/{id}/issues),
 * paginated. Returns raw issue objects — each carries its own project:{id,name}, status:{name,
 * is_closed_type}, and assignee:{zpuid,name}. One paginated pass replaces an N-project fan-out.
 */
export async function listAllPortalIssues(env: Env): Promise<any[]> {
  const out: any[] = [];
  const MAX_PAGES = 25; // per_page 200 -> up to 5000 issues
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await zohoFetch(env, `/portal/${portal(env)}/issues`, { query: { page, per_page: 200 } });
    const arr: any[] =
      data?.issues ?? data?.data?.issues ?? data?.result ?? (Array.isArray(data) ? data : []);
    out.push(...arr);
    const hasNext = data?.page_info?.has_next_page ?? data?.data?.page_info?.has_next_page;
    if (hasNext === false || arr.length < 200) break; // last page
  }
  return out;
}

/** True if a project looks like a client SERVICE project (per the configured match mode). */
export function isServiceProject(env: Env, p: ZohoProject): boolean {
  const match = serviceMatch(env);
  switch (match.mode) {
    case "tag":
      return projectHasTag(p.raw, match.value);
    case "group":
      return projectInGroup(p.raw, match.value);
    case "name_suffix":
    default:
      return p.name.toUpperCase().trimEnd().endsWith(match.value.toUpperCase());
  }
}

/** Fetch a single project (with its custom fields). */
export async function getProject(env: Env, projectId: string): Promise<ZohoProject> {
  const data = await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}`);
  const p = data.projects?.[0] ?? data.project ?? data;
  return normalizeProject(p);
}

/** Read the three access-code custom fields off a project. */
export async function getAccessCodes(env: Env, projectId: string): Promise<AccessCodes> {
  const p = await getProject(env, projectId);
  return {
    gate_code: p.customFields["gate_code"] ?? null,
    community_gate: p.customFields["community_gate"] ?? null,
    door_code: p.customFields["door_code"] ?? null,
  };
}

/**
 * Write access codes back to the PROJECT (site codes = single source of truth).
 * Only supplied keys are written.
 */
export async function updateAccessCodes(
  env: Env,
  projectId: string,
  codes: Partial<AccessCodes>
): Promise<void> {
  // v3: project custom fields are also TOP-LEVEL keys by field_name (no wrapper) —
  // gate_code / community_gate / door_code came back as top-level keys on the project.
  const payload: Record<string, string> = {};
  if (codes.gate_code !== undefined && codes.gate_code !== null) payload["gate_code"] = codes.gate_code;
  if (codes.community_gate !== undefined && codes.community_gate !== null)
    payload["community_gate"] = codes.community_gate;
  if (codes.door_code !== undefined && codes.door_code !== null) payload["door_code"] = codes.door_code;
  if (Object.keys(payload).length === 0) return;

  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Write arbitrary custom fields back to a PROJECT (v3: custom fields are TOP-LEVEL keys by
 * field_name, no wrapper — same shape as updateAccessCodes). Only the supplied keys are written.
 */
export async function updateProjectFields(
  env: Env,
  projectId: string,
  fields: Record<string, string>
): Promise<void> {
  if (!fields || Object.keys(fields).length === 0) return;
  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

//------------------------------------------------------------------------------
// Task lists (= service tickets)
//------------------------------------------------------------------------------

/** Create the ticket task-list. Returns its id. */
export async function createTaskList(env: Env, projectId: string, name: string): Promise<ZohoTaskList> {
  const data = await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasklists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      // TODO(craig): tasklist "flag" (internal/external) — set from env if your portal requires it.
      flag: env.ZOHO_TASKLIST_FLAG ?? "internal",
    }),
  });
  const tl = data.tasklists?.[0] ?? data.tasklist ?? data;
  return normalizeTaskList(tl);
}

/**
 * Rename a task-list (PATCH its `name`). Mirrors createTaskList's endpoint —
 * createTaskList POSTs to `.../tasklists`, so this PATCHes `.../tasklists/{taskListId}`
 * with `{ name }`. Used on WO create to prefix the ticket name with the full WO number.
 */
export async function updateTaskList(
  env: Env,
  projectId: string,
  taskListId: string,
  name: string
): Promise<void> {
  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasklists/${taskListId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** Get task-lists for a project (used to know if a ticket list is completed). */
export async function getTaskLists(env: Env, projectId: string): Promise<ZohoTaskList[]> {
  const data = await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasklists`, {
    query: { index: 1, range: 200 },
  });
  const lists: any[] = data.tasklists ?? [];
  return lists.map(normalizeTaskList);
}

/** Delete a task list (and its tasks) — used to delete/cancel a whole WO ticket. */
export async function deleteTaskList(env: Env, projectId: string, taskListId: string): Promise<void> {
  try {
    await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasklists/${taskListId}`, {
      method: "DELETE",
    });
  } catch (e) {
    // Already gone is fine; rethrow anything else.
    if (e instanceof ZohoError && /\b404\b/.test(e.message)) return;
    throw e;
  }
}

//------------------------------------------------------------------------------
// Tasks (Action / Billing) + subtasks (steps)
//------------------------------------------------------------------------------

export interface CreateTaskOpts {
  name: string;
  taskListId: string;
  description?: string;
  priority?: string;
  parentTaskId?: string;   // set for subtasks (steps under Action)
  customFields?: Record<string, string>;
}

/** Create a task (Action, Billing) or a subtask (step). Returns its id. */
export async function createTask(env: Env, projectId: string, opts: CreateTaskOpts): Promise<ZohoTask> {
  // v3 task shapes (confirmed against the live API schema):
  //  - task list is targeted with `tasklist: { id }` (NOT `tasklist_id`)
  //  - priority is a lowercase enum: none|low|medium|high
  //  - subtasks use `parental_info: { parent_task_id }`
  //  - custom fields are TOP-LEVEL body keys (there is NO `custom_fields` wrapper)
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.taskListId) body.tasklist = { id: opts.taskListId };
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.priority !== undefined && opts.priority !== null) {
    const p = String(opts.priority).toLowerCase();
    if (["none", "low", "medium", "high"].includes(p)) body.priority = p;
  }
  if (opts.parentTaskId !== undefined) body.parental_info = { parent_task_id: opts.parentTaskId };
  if (opts.customFields) Object.assign(body, opts.customFields);

  const data = await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = data.tasks?.[0] ?? data.task ?? data;
  return normalizeTask(t);
}

/** Create the Action task subtasks (steps). Sequential to keep parent linkage simple. */
export async function createSteps(
  env: Env,
  projectId: string,
  taskListId: string,
  actionTaskId: string,
  steps: string[],
  customFields?: Record<string, string>
): Promise<ZohoTask[]> {
  const out: ZohoTask[] = [];
  for (const step of steps) {
    out.push(
      await createTask(env, projectId, {
        name: step,
        taskListId,
        parentTaskId: actionTaskId,
        customFields,
      })
    );
  }
  return out;
}

/**
 * Write the FULL composite WO string into the task's "Work Orders #" custom field.
 * The field NAME is resolved in exactly one place (config.woFieldName) and this
 * refuses to run until it's configured (config.assertWoFieldConfigured).
 */
export async function setWorkOrderField(
  env: Env,
  projectId: string,
  taskId: string,
  fullWoNumber: string
): Promise<void> {
  assertWoFieldConfigured(env);
  const field = woFieldName(env);

  // v3: custom fields are TOP-LEVEL body keys named by their API field_name — no wrapper.
  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: fullWoNumber }),
  });
}

/**
 * Set one or more task custom fields (v3: top-level keys by API field_name).
 * Generic version of setWorkOrderField — used to mirror the schedule into the
 * wo_schedule / wo_date_time / wo_schedule_status fields for Zoho-native filtering.
 */
export async function setTaskFields(
  env: Env,
  projectId: string,
  taskId: string,
  fields: Record<string, string>
): Promise<void> {
  if (!fields || Object.keys(fields).length === 0) return;
  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

/** Generic task PATCH with an arbitrary v3 body (status {id}, is_completed, custom fields...). */
export async function patchTask(
  env: Env,
  projectId: string,
  taskId: string,
  body: Record<string, unknown>
): Promise<void> {
  if (!body || Object.keys(body).length === 0) return;
  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Set a task's description (the "notes/link" field of the Action task). */
export async function setTaskDescription(
  env: Env,
  projectId: string,
  taskId: string,
  description: string
): Promise<void> {
  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
}

/**
 * Open or close a task (drives the derived WO status).
 *
 * Status ids are PER PROJECT: each Zoho project has its own status workflow, so a
 * closed-status id from the service projects is invalid for the purchasing project.
 * Callers therefore pass the ids that belong to the task's project via `statusIds`:
 *   - omit `statusIds`  -> use the SERVICE-project ids (ZOHO_STATUS_*_ID). Default for
 *     the Action/Billing tasks.
 *   - pass `statusIds`  -> use those ids; when both are empty/unset, fall back to the
 *     top-level `is_completed` boolean (no cross-project status id is ever sent).
 */
export async function setTaskCompleted(
  env: Env,
  projectId: string,
  taskId: string,
  completed: boolean,
  statusIds?: { openId?: string; closedId?: string }
): Promise<void> {
  const ids =
    statusIds ?? { openId: env.ZOHO_STATUS_OPEN_ID, closedId: env.ZOHO_STATUS_CLOSED_ID };
  const statusId = completed ? ids.closedId : ids.openId;

  const body: Record<string, unknown> = {};
  if (statusId) {
    body.status = { id: statusId }; // v3: status is set via { id }
  } else {
    // v3 accepts the top-level boolean `is_completed`.
    body.is_completed = completed;
  }

  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Get a single task (for GET /work-orders/:id). */
export async function getTask(env: Env, projectId: string, taskId: string): Promise<ZohoTask> {
  const data = await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}`);
  const t = data.tasks?.[0] ?? data.task ?? data;
  return normalizeTask(t);
}

/** Get all tasks for a project (used to assemble WOs + derive status). */
export async function getTasksByProject(env: Env, projectId: string): Promise<ZohoTask[]> {
  const data = await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks`, {
    query: { index: 1, range: 500 },
  });
  const tasks: any[] = data.tasks ?? [];
  return tasks.map(normalizeTask);
}

/**
 * Get the SUBTASKS in a project (has_parents=true). The default /tasks listing returns
 * top-level tasks only, so item/visit subtasks (under the per-WO "Items"/"Schedule"
 * tasks) need this. Callers filter by `parentTaskId` to a specific parent.
 * VERIFY-LIVE (2026-08-23): the `has_parents` param + `parental_info.parent_task_id`
 * in the response are per the Zoho Projects v3 docs; smoke-test on first deploy.
 */
export async function getSubtasksByProject(env: Env, projectId: string): Promise<ZohoTask[]> {
  const data = await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks`, {
    query: { index: 1, range: 500, has_parents: "true" },
  });
  const tasks: any[] = data.tasks ?? [];
  return tasks.map(normalizeTask);
}

/**
 * Portal-wide SUBTASK query (paginated), for cross-WO aggregation (the Items dashboard).
 * Returns every subtask across the portal; callers filter (e.g. to those carrying
 * order_status = item subtasks). VERIFY-LIVE: same has_parents caveat as above.
 */
export async function getPortalSubtasks(env: Env, perPage = 200): Promise<ZohoTask[]> {
  const MAX_PAGES = 25;
  const out: ZohoTask[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await zohoFetch(env, `/portal/${portal(env)}/tasks`, {
      query: { has_parents: "true", per_page: perPage, page },
    });
    const tasks: any[] = data.tasks ?? [];
    for (const t of tasks) out.push(normalizeTask(t));
    if (!data?.page_info?.has_next_page) break;
  }
  return out;
}

/** Delete a task (used to remove a visit subtask). Idempotent-ish: a 404 is swallowed. */
export async function deleteTask(env: Env, projectId: string, taskId: string): Promise<void> {
  try {
    await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}`, {
      method: "DELETE",
    });
  } catch (e) {
    if (e instanceof ZohoError && /\b40[04]\b/.test(String(e.message))) return; // already gone
    throw e;
  }
}

/**
 * Diagnostic: does a task custom field exist on the layout (resolvable by the portal
 * task-filter)? A field_name that resolves returns 200; an unknown one returns 400
 * FIELDS_VALIDATION_ERROR. This is the technique used to live-verify `provision`.
 */
export async function resolveTaskField(env: Env, fieldName: string): Promise<boolean> {
  const filter = JSON.stringify({
    criteria: [{ field_name: fieldName, criteria_condition: "is", value: ["__probe__"] }],
    pattern: "1",
  });
  try {
    await zohoFetch(env, `/portal/${portal(env)}/tasks`, { query: { filter, per_page: 1, page: 1 } });
    return true;
  } catch (e) {
    // A throttle also comes back as a 400 — never misread it as "field doesn't exist".
    if (e instanceof ZohoThrottleError) throw e;
    if (e instanceof ZohoError && /\b400\b/.test(String(e.message))) return false;
    throw e;
  }
}

/**
 * Portal-wide task query (ONE paginated call) via the confirmed endpoint
 * `GET /portal/{portalId}/tasks?filter=<url-encoded JSON>`. This is the whole
 * point of the optimization: instead of scanning all ~250 projects (which times
 * out), we filter tasks server-side across the entire portal and get back only
 * the rows we want in a handful of pages.
 *
 * `filterJson` is the JSON string the caller builds, e.g.
 *   {"criteria":[{"field_name":"work_order_hash","criteria_condition":"contains","value":["-WO-"]}],"pattern":"1"}
 * The confirmed WO custom column is `work_order_hash` (== woFieldName(env) once
 * configured); we keep that literal in the filter since it's the live column name.
 *
 * Paginates on `data.page_info.has_next_page` until false, with a ~25-page safety
 * stop so a bad filter can never loop unbounded.
 */
export async function listPortalTasksByFilter(
  env: Env,
  filterJson: string,
  perPage = 200
): Promise<ZohoTask[]> {
  const MAX_PAGES = 25; // safety stop (per_page max is 200 → up to 5000 tasks)
  const out: ZohoTask[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await zohoFetch(env, `/portal/${portal(env)}/tasks`, {
      query: { filter: filterJson, per_page: perPage, page },
    });
    const tasks: any[] = data.tasks ?? [];
    for (const t of tasks) out.push(normalizeTask(t));
    if (!data?.page_info?.has_next_page) break;
  }
  return out;
}

//------------------------------------------------------------------------------
// Purchasing (parts request -> purchasing dashboard). Requested parts become
// tasks in the FHI-907 purchasing PROJECT; each task carries order_status and
// reuses the work_order_hash field to point back to the SOURCE work order.
//------------------------------------------------------------------------------

/**
 * Create a task in the purchasing project for a requested part.
 *  - tasklist is OMITTED: the create_a_task schema makes it optional and defaults
 *    to the project's general list, so we don't manage a list here.
 *  - description = note + optional "Qty: N" line (the caller may fold a machine
 *    trailer into `note` — e.g. "[src-wo-id:<id>]" — to link back to the WO).
 *  - order_status (DEFAULT_ORDER_STATUS, "Needed") and work_order_hash (source
 *    WO ref) are written via a FOLLOW-UP setTaskFields PATCH after create.
 *
 * TODO(craig): confirm custom fields can't just be set in the create_a_task body
 * for this portal; if they can, fold them into createTask({ customFields }) to save
 * a call. A follow-up PATCH is used here as the safe default.
 */
export async function createPurchaseTask(
  env: Env,
  input: { item: string; quantity?: number | null; note?: string | null; sourceWo?: string | null; status?: string | null }
): Promise<ZohoTask> {
  assertPurchasingConfigured(env);
  const projectId = purchasingProjectId(env);

  const parts: string[] = [];
  if (input.note && input.note.trim()) parts.push(input.note.trim());
  if (input.quantity !== undefined && input.quantity !== null) parts.push(`Qty: ${input.quantity}`);
  const description = parts.join("\n");

  // tasklist omitted -> defaults to the project's general list.
  const task = await createTask(env, projectId, {
    name: input.item,
    taskListId: "",
    description,
  });

  // Follow-up: set the pick-list status + link the source WO via work_order_hash.
  // NON-FATAL: the task already exists, so a field-write hiccup must NOT fail the
  // whole part request. On failure we warn and continue — the PurchaseItem the
  // service builds still defaults order_status to DEFAULT_ORDER_STATUS ("Needed").
  // TODO(craig): the order_status pick-list write may need the option id rather than the display value "Needed" — verify on the live task.
  const initialStatus = input.status && input.status.trim() ? input.status.trim() : DEFAULT_ORDER_STATUS;
  const fields: Record<string, string> = { [orderStatusFieldName(env)]: initialStatus };
  if (input.sourceWo) fields[woFieldName(env)] = input.sourceWo;
  try {
    await setTaskFields(env, projectId, task.id, fields);
  } catch (e) {
    console.warn("createPurchaseTask: setTaskFields failed (non-fatal):", e);
  }

  // Re-read so the returned task carries the fields we just set. NON-FATAL: if the
  // re-read throws, fall back to the task object returned by createTask so the
  // request still succeeds (the task WAS created).
  try {
    return await getTask(env, projectId, task.id);
  } catch (e) {
    console.warn("createPurchaseTask: getTask re-read failed (non-fatal):", e);
    return task;
  }
}

/** Delete a purchasing task (= an item). Idempotent-ish: a 404 is swallowed by deleteTask. */
export async function deletePurchaseTask(env: Env, taskId: string): Promise<void> {
  assertPurchasingConfigured(env);
  await deleteTask(env, purchasingProjectId(env), taskId);
}

/** List every task in the purchasing project (the raw dashboard rows). */
export async function listPurchaseTasks(env: Env): Promise<ZohoTask[]> {
  assertPurchasingConfigured(env);
  // getTasksByProject requests range 500 in one call — plenty for the dashboard.
  return getTasksByProject(env, purchasingProjectId(env));
}

/**
 * Update a purchasing task: status (order_status pick-list) and/or its description
 * (notes). Both are optional; only supplied ones are written.
 */
export async function updatePurchaseTask(
  env: Env,
  taskId: string,
  fields: { status?: string; description?: string }
): Promise<void> {
  assertPurchasingConfigured(env);
  const projectId = purchasingProjectId(env);
  if (fields.status) {
    await setTaskFields(env, projectId, taskId, { [orderStatusFieldName(env)]: fields.status });
  }
  if (fields.description !== undefined) {
    await setTaskDescription(env, projectId, taskId, fields.description);
  }
}

//------------------------------------------------------------------------------
// Portal users + task time logs (Feature B — native Zoho time logs).
//------------------------------------------------------------------------------

interface PortalUser {
  zpuid: string;
  email: string;
  name: string;
}

// Module-level cache for the isolate: the portal-user list changes rarely and is
// only needed to map a tech email -> zpuid, so one fetch per isolate is plenty.
let portalUsersCache: PortalUser[] | null = null;

/** Test seam: clear the portal-users cache. */
export function _clearPortalUsersCache(): void {
  portalUsersCache = null;
}

/**
 * List portal users (to map a tech's email -> their Zoho user id / zpuid).
 * Cached per-isolate. Parsed defensively because the v3 users payload shape
 * varies across portals.
 *
 * TODO(craig): confirm the v3 users path + field names. Commonly
 * `/portal/{portalId}/users`; each user may expose zpuid as `zpuid` or `id`,
 * and the list may sit under `data.users`, `users`, or `data`.
 */
export async function getPortalUsers(env: Env): Promise<PortalUser[]> {
  if (portalUsersCache) return portalUsersCache;

  // TODO(craig): confirm the v3 users path.
  const data = await zohoFetch(env, `/portal/${portal(env)}/users`);

  const raw: any[] = data?.data?.users ?? data?.users ?? data?.data ?? (Array.isArray(data) ? data : []);
  const users: PortalUser[] = raw.map((u: any) => ({
    // TODO(craig): confirm the user id field name (zpuid vs id) + email/name keys.
    zpuid: String(u?.zpuid ?? u?.id ?? u?.id_string ?? ""),
    email: String(u?.email ?? u?.email_id ?? ""),
    name: String(u?.name ?? u?.full_name ?? ""),
  }));

  portalUsersCache = users;
  return users;
}

/**
 * Create a native Zoho task time log against a task. This drives the task's
 * `log_hours.total_hours` running total that the WorkOrder surfaces.
 *
 * TODO(craig): confirm v3 time-log endpoint + body. Endpoint and every uncertain
 * body key are isolated here so correcting them against the live API is a one-line fix.
 */
export async function logTaskHours(
  env: Env,
  projectId: string,
  taskId: string,
  opts: { ownerZpuid?: string; hours: number; date?: string; billable?: boolean; notes?: string }
): Promise<void> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD (today)

  // TODO(craig): confirm v3 time-log endpoint + body.
  const body: Record<string, unknown> = {
    date,                                                              // TODO(craig): date format/key
    bill_status: opts.billable === false ? "Non Billable" : "Billable", // TODO(craig): bill_status key/values
    hours: String(opts.hours),                                         // TODO(craig): hours key/format (String vs number)
    notes: opts.notes ?? "",                                           // TODO(craig): notes key
  };
  if (opts.ownerZpuid) body.owner = opts.ownerZpuid;                   // TODO(craig): owner key (owner vs owner_id/zpuid)

  // TODO(craig): confirm the v3 time-log path (.../tasks/{taskId}/logs).
  await zohoFetch(env, `/portal/${portal(env)}/projects/${projectId}/tasks/${taskId}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

//------------------------------------------------------------------------------
// Normalizers — isolate every "which field is it really called" guess here.
//------------------------------------------------------------------------------
function normalizeProject(p: any): ZohoProject {
  const cf = extractCustomFields(p);
  // Site fields are TOP-LEVEL keys on the v3 project object; fall back to the
  // custom-fields map (some portals surface them there) and default to null.
  const siteField = (topKey: string): string | null => {
    const top = p?.[topKey];
    if (top !== undefined && top !== null && String(top) !== "") return String(top);
    const inCf = cf[topKey];
    return inCf !== undefined && inCf !== null && String(inCf) !== "" ? String(inCf) : null;
  };
  return {
    id: String(p?.id ?? p?.id_string ?? ""),
    name: String(p?.name ?? ""),
    key: p?.key ?? p?.project_key ?? null, // TODO(craig): confirm the v3 project-key field name.
    siteAddress: siteField("site_address"),
    siteCity: siteField("site_city"),
    siteState: siteField("site_state"),
    siteZip: siteField("site_zip"),
    openIssues: Number(p?.issues?.open_count ?? 0),
    closedIssues: Number(p?.issues?.closed_count ?? 0),
    customFields: cf,
    raw: p,
  };
}

function normalizeTask(t: any): ZohoTask {
  const status = t?.status ?? {};
  // Closed/completed detection covers both the per-project task shape (`completed`
  // / status name) and the portal-wide task shape (`status.is_closed_type` and the
  // top-level `is_completed` flag confirmed on the live portal query).
  const isCompleted =
    typeof t?.completed === "boolean"
      ? t.completed
      : typeof status?.is_closed_type === "boolean"
      ? status.is_closed_type
      : typeof t?.is_completed === "boolean"
      ? t.is_completed
      : String(status?.type ?? status?.name ?? "").toLowerCase() === "closed";
  const createdTime = t?.created_time ?? t?.created_time_long ?? null;
  const lastModifiedTime = t?.last_modified_time ?? t?.last_updated_time ?? t?.updated_time ?? null;
  const customFields = extractCustomFields(t);
  return {
    id: String(t?.id ?? t?.id_string ?? ""),
    name: String(t?.name ?? ""),
    description: t?.description ?? null,
    isCompleted,
    statusName: status?.name ?? null,
    priority: t?.priority ?? null,
    taskListId: t?.tasklist?.id ? String(t.tasklist.id) : t?.tasklist_id ? String(t.tasklist_id) : null,
    customFields,
    createdAt: createdTime,
    updatedAt: lastModifiedTime,
    raw: t,
    // Optional portal-query fields (present only when the raw payload carries them).
    // The WO# lives in the confirmed `work_order_hash` custom column; fall back to the
    // same key inside customFields for the per-project task shape.
    workOrderHash: t?.work_order_hash ?? customFields["work_order_hash"] ?? null,
    // Subtask linkage: Zoho returns the parent under `parental_info` (and sometimes a
    // flat `parent_task`/`parent_task_id`). Null when this is a top-level task.
    parentTaskId:
      t?.parental_info?.parent_task_id != null
        ? String(t.parental_info.parent_task_id)
        : t?.parent_task?.id != null
        ? String(t.parent_task.id)
        : t?.parent_task_id != null
        ? String(t.parent_task_id)
        : null,
    projectId: t?.project?.id != null ? String(t.project.id) : null,
    projectName: t?.project?.name ?? null,
    taskListName: t?.tasklist?.name ?? null,
    createdTime,
    lastModifiedTime,
  };
}

function normalizeTaskList(tl: any): ZohoTaskList {
  return {
    id: String(tl?.id ?? tl?.id_string ?? ""),
    name: String(tl?.name ?? ""),
    isCompleted: Boolean(tl?.completed ?? tl?.is_completed ?? false),
    raw: tl,
  };
}

/**
 * Flatten Zoho custom fields into a simple { apiName: value } map.
 * Zoho returns custom fields in several shapes across versions; handle the
 * common ones. TODO(craig): confirm against a live payload and prune.
 */
function extractCustomFields(obj: any): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!obj) return out;

  // Shape A: custom_fields as an array of { label_name / column_name / value }.
  const arr = obj.custom_fields ?? obj.customfields;
  if (Array.isArray(arr)) {
    for (const cf of arr) {
      const key = cf?.column_name ?? cf?.api_name ?? cf?.label_name ?? cf?.label;
      if (key) out[String(key)] = cf?.value ?? null;
    }
    return out;
  }

  // Shape B: custom_fields as a plain { apiName: value } object.
  if (arr && typeof arr === "object") {
    for (const [k, v] of Object.entries(arr)) out[k] = (v as any) ?? null;
  }
  return out;
}

function projectHasTag(raw: any, tagName: string): boolean {
  const tags: any[] = raw?.tags ?? [];
  return tags.some((t) => String(t?.name ?? t).toLowerCase() === tagName.toLowerCase());
}

function projectInGroup(raw: any, groupId: string): boolean {
  const g = raw?.group?.id ?? raw?.group_id;
  return g !== undefined && String(g) === groupId;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

export class ZohoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZohoError";
  }
}

/**
 * Zoho Projects rate limit (~100 requests per API endpoint per rolling 2 minutes). Zoho reports it
 * as an HTTP 400 with title URL_ROLLING_THROTTLES_LIMIT_EXCEEDED and "Try again after N minutes"
 * (live 2026-09-03), so it must be classified by BODY, not status — otherwise it is mistaken for a
 * validation error and swallowed. Callers may serve cached/partial data and tell the user when to retry.
 */
export class ZohoThrottleError extends ZohoError {
  retryAfterMin: number;
  constructor(message: string, retryAfterMin: number) {
    super(message);
    this.name = "ZohoThrottleError";
    this.retryAfterMin = retryAfterMin;
  }
}

/** True when a Zoho error body is a rate-limit response (throttle or classic 429). */
export function isZohoThrottleBody(status: number, body: string): boolean {
  return status === 429 || /URL_ROLLING_THROTTLES_LIMIT_EXCEEDED|too many requests|rate limit/i.test(body || "");
}

/** Parse "Try again after N minutes" (defaults to 2 — one rolling window). */
export function parseRetryAfterMin(body: string): number {
  const m = (body || "").match(/after\s+(\d+)\s*minute/i);
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** Build the right error for a failed Zoho response (shared by every Zoho fetch helper). */
export function zohoFailure(prefix: string, status: number, body: string): ZohoError {
  const msg = `${prefix}: ${status} ${body}`;
  return isZohoThrottleBody(status, body) ? new ZohoThrottleError(msg, parseRetryAfterMin(body)) : new ZohoError(msg);
}
