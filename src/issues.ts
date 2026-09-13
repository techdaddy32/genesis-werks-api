//==============================================================================
// issues.ts — Zoho Projects Issues client ("Action Items").
//
// In FHI's portal the Issues/Bugs module is RENAMED "Action Items". These are
// PROJECT-level records (not per-task). Like forums, the Issues API is on the
// classic REST base (https://projectsapi.zoho.com/restapi/...), same OAuth token,
// with query-string write params. Requires ZohoProjects.bugs.ALL on the token
// (added to /setup 2026-08-27 — needs a re-auth to take effect).
//
// Endpoints (https://www.zoho.com/projects/help/rest-api/bugs-api.html):
//   GET  /bugs/                     list issues (?statustype=open|closed, index, range)
//   GET  /bugs/{id}/                one issue (with description)
//   POST /bugs/                     create (title*, description, assignee_zpuid, flag)
//   POST /bugs/{id}/                update (title, description, status_id, assignee_zpuid, flag)
//   GET  /bugs/defaultfields/       status/severity/module/classification option lists
//   GET  /bugs/{id}/comments/       list comments
//   POST /bugs/{id}/comments/       add comment (content)
//
// VERIFY-LIVE (2026-08-27): write params on the query string (classic REST); flip
// FORM_IN_BODY if a create/update 400s on a mandatory param. Status is NOT settable
// on create (Zoho assigns the default) — a requested status is applied via a follow-up
// update.
//==============================================================================

import type { Env } from "./types";
import { getAccessToken, ZohoError, ZohoThrottleError, zohoFailure, listServiceProjects, listAllPortalIssues } from "./zoho";

function restBase(env: Env): string {
  try {
    return new URL(env.ZOHO_API_BASE).origin + "/restapi";
  } catch {
    return "https://projectsapi.zoho.com/restapi";
  }
}

const portal = (env: Env) => env.ZOHO_PORTAL_ID;
const bugsRoot = (env: Env, projectId: string) =>
  `/portal/${portal(env)}/projects/${projectId}/bugs`;

async function restFetch(
  env: Env,
  path: string,
  init: {
    method?: string;
    query?: Record<string, string | number | undefined>;
    form?: Record<string, string | number | boolean | undefined>;
  } = {}
): Promise<any> {
  const FORM_IN_BODY = false; // flip if a create/update 400s on a mandatory param
  const token = await getAccessToken(env);
  const { method = "GET", query, form } = init;

  let url = restBase(env) + path;
  const qs = (obj: Record<string, string | number | boolean | undefined>) =>
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");

  const merged: Record<string, string | number | boolean | undefined> = { ...(query ?? {}) };
  if (form && !FORM_IN_BODY) Object.assign(merged, form);
  const s = qs(merged);
  if (s) url += (url.includes("?") ? "&" : "?") + s;

  const headers: Record<string, string> = {
    Authorization: `Zoho-oauthtoken ${token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (form && FORM_IN_BODY) {
    body = qs(form);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    let detail = "<no body>";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw zohoFailure(`Zoho issues ${method} ${path} failed`, res.status, detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

//------------------------------------------------------------------------------
// Normalized shapes
//------------------------------------------------------------------------------
export interface ActionItem {
  id: string;
  key: string | null; // prefix e.g. "SK1-I2"
  title: string;
  description: string | null;
  flag: string; // Internal | External
  statusId: string | null;
  statusName: string | null;
  closed: boolean;
  assigneeName: string | null;
  assigneeZpuid: string | null;
  createdTime: string | null;
  updatedTime: string | null;
}

export interface ActionItemStatus {
  id: string;
  name: string;
  closed: boolean;
  isDefault: boolean;
}

function s(v: any): string | null {
  const x = v == null ? "" : String(v);
  return x === "" ? null : x;
}

/**
 * The real issue id. Zoho's REST list/detail return a BOGUS top-level `id` (the same
 * value for every row in a project); the authoritative id is the trailing segment of
 * link.self.url (…/bugs/{id}/). Prefer that, fall back to `id`.
 */
function extractBugId(raw: any): string {
  const selfUrl: string | undefined = raw?.link?.self?.url;
  if (selfUrl) {
    const m = String(selfUrl).match(/\/bugs\/(\d+)\/?$/);
    if (m) return m[1];
  }
  return String(raw?.id ?? "");
}

/** Normalize an issue from either the classic REST shape or the v3 shape. */
function normalizeIssue(b: any): ActionItem {
  const status = b?.status ?? {};
  const closed =
    typeof b?.closed === "boolean"
      ? b.closed
      : typeof status?.is_closed_type === "boolean"
      ? status.is_closed_type
      : false;
  // assignee: v3 => assignee:{zpuid,name}; REST => assignee_name / assignee_zpuid / assignee_id
  const assignee = b?.assignee ?? {};
  return {
    id: extractBugId(b),
    key: s(b?.prefix ?? b?.key),
    title: String(b?.title ?? b?.name ?? ""),
    description: s(b?.description),
    flag: String(b?.flag ?? "Internal"),
    statusId: s(status?.id),
    statusName: s(status?.name ?? status?.type),
    closed,
    assigneeName: s(assignee?.name ?? b?.assignee_name),
    assigneeZpuid: s(assignee?.zpuid ?? b?.assignee_zpuid ?? b?.assignee_id),
    createdTime: s(b?.created_time ?? b?.created_time_format),
    updatedTime: s(b?.last_updated_time ?? b?.updated_time ?? b?.updated_time_format),
  };
}

//------------------------------------------------------------------------------
// CRUD
//------------------------------------------------------------------------------

/** List a project's action items (issues). statustype: open | closed | undefined (all). */
export async function listActionItems(
  env: Env,
  projectId: string,
  opts: { statustype?: "open" | "closed" } = {}
): Promise<ActionItem[]> {
  const data = await restFetch(env, `${bugsRoot(env, projectId)}/`, {
    query: { index: 1, range: 200, statustype: opts.statustype },
  });
  const bugs: any[] = data?.bugs ?? [];
  return bugs.map(normalizeIssue);
}

/** One action item's details (includes description). */
export async function getActionItem(
  env: Env,
  projectId: string,
  issueId: string
): Promise<ActionItem | null> {
  const data = await restFetch(env, `${bugsRoot(env, projectId)}/${issueId}/`);
  const b = data?.bugs?.[0];
  return b ? normalizeIssue(b) : null;
}

export interface AddActionItemInput {
  title: string;
  description?: string;
  flag?: string; // Internal | External
  assigneeZpuid?: string;
  statusId?: string; // applied via a follow-up update (create can't set status)
}

/** Create an action item. Status defaults to the project's default; a requested statusId is applied after. */
export async function addActionItem(
  env: Env,
  projectId: string,
  input: AddActionItemInput
): Promise<ActionItem | null> {
  await invalidateAggregateCache(env);
  const data = await restFetch(env, `${bugsRoot(env, projectId)}/`, {
    method: "POST",
    form: {
      title: input.title,
      description: input.description,
      flag: input.flag,
      assignee_zpuid: input.assigneeZpuid,
    },
  });
  const created = data?.bugs?.[0];
  if (!created) return null;
  const item = normalizeIssue(created);
  // Apply a non-default status if requested (best-effort).
  if (input.statusId && input.statusId !== item.statusId) {
    try {
      const updated = await updateActionItem(env, projectId, item.id, { statusId: input.statusId });
      if (updated) return updated;
    } catch (e) {
      console.warn("addActionItem: status apply failed (non-fatal):", e);
    }
  }
  return item;
}

export interface UpdateActionItemInput {
  title?: string;
  description?: string;
  flag?: string;
  statusId?: string;
  assigneeZpuid?: string;
}

/** Update an action item (title / description / status / assignee / flag). */
export async function updateActionItem(
  env: Env,
  projectId: string,
  issueId: string,
  patch: UpdateActionItemInput
): Promise<ActionItem | null> {
  await invalidateAggregateCache(env);
  const data = await restFetch(env, `${bugsRoot(env, projectId)}/${issueId}/`, {
    method: "POST",
    form: {
      title: patch.title,
      description: patch.description,
      flag: patch.flag,
      status_id: patch.statusId,
      assignee_zpuid: patch.assigneeZpuid,
    },
  });
  const b = data?.bugs?.[0];
  return b ? normalizeIssue(b) : await getActionItem(env, projectId, issueId);
}

//------------------------------------------------------------------------------
// Comments (on an issue / action item)
//------------------------------------------------------------------------------
export interface IssueComment {
  id: string;
  content: string;
  addedPerson: string | null;
  addedTime: string | null;
}

function normalizeComment(c: any): IssueComment {
  return {
    id: String(c?.comment_id ?? c?.id ?? ""),
    content: String(c?.comment ?? c?.content ?? ""),
    addedPerson: s(c?.added_person ?? c?.updated_person),
    addedTime: s(c?.created_time_format ?? c?.created_time ?? c?.updated_time_format),
  };
}

/** List an action item's comments (newest last, as Zoho returns them). */
export async function listComments(
  env: Env,
  projectId: string,
  issueId: string
): Promise<IssueComment[]> {
  const data = await restFetch(env, `${bugsRoot(env, projectId)}/${issueId}/comments/`, {
    query: { index: 1, range: 100 },
  });
  const comments: any[] = data?.comments ?? [];
  return comments.map(normalizeComment);
}

/** Add a comment to an action item. */
export async function addComment(
  env: Env,
  projectId: string,
  issueId: string,
  content: string
): Promise<IssueComment | null> {
  const data = await restFetch(env, `${bugsRoot(env, projectId)}/${issueId}/comments/`, {
    method: "POST",
    form: { content },
  });
  const c = data?.comments?.[0];
  return c ? normalizeComment(c) : null;
}

//------------------------------------------------------------------------------
// Cross-project aggregation (the central "Action Items" dashboard).
//------------------------------------------------------------------------------
export interface DashboardActionItem extends ActionItem {
  projectId: string;
  projectName: string;
}

/**
 * Aggregate action items across all SERVICE projects for the central dashboard.
 * Uses the projects list's per-project issue COUNTS to only query the (few) projects
 * that actually have issues — avoiding a fan-out over every project. statustype filters
 * open/closed; undefined = all.
 */
export async function aggregateActionItems(
  env: Env,
  statustype?: "open" | "closed"
): Promise<DashboardActionItem[]> {
  return (await aggregateActionItemsWithMeta(env, statustype)).items;
}

/** Diagnostics for `GET /action-items?debug=1` — shows which path populated the dashboard. */
export interface AggregateMeta {
  serviceProjects: number;
  withCounts: number;
  path: "counts" | "portal" | "scan";
  /** Zoho rate limit hit while aggregating (result is partial or a stale cache). */
  throttled?: boolean;
  /** Minutes until Zoho's rolling window clears (from Zoho's own message). */
  retryAfterMin?: number;
  /** Served from the short-TTL cache (no Zoho calls). */
  cached?: boolean;
  /** Cache older than the fresh window, served only because Zoho is throttling. */
  stale?: boolean;
  /** ISO time the served data was fetched from Zoho. */
  fetchedAt?: string;
  /** Projects skipped because of the throttle (ids). */
  failedProjects?: string[];
}

//------------------------------------------------------------------------------
// Aggregate cache — memory (per isolate). The dashboard re-pulled ~25 Zoho calls on EVERY
// close/edit/filter, which tripped Zoho's 100-per-API-per-2-minutes cap (live 2026-09-03) and
// the swallowed errors looked like "all my action items vanished". Fresh window = AGG_FRESH_MS;
// a stale copy is kept AGG_STALE_TTL_S so a throttled request can still show the last-known
// list instead of nothing. Mutations invalidate the cache. F3: the KV (cross-isolate) copy is
// gone — genesis-api has no KV binding; a cold isolate re-fetches (temporary until P3a).
//------------------------------------------------------------------------------
const AGG_FRESH_MS = 90_000;
const AGG_STALE_TTL_S = 30 * 60;
interface AggCacheEntry {
  at: number;
  items: DashboardActionItem[];
  meta: AggregateMeta;
}
const aggMem = new Map<string, AggCacheEntry>();
const aggKey = (statustype?: "open" | "closed") => `ai:agg:${statustype ?? "all"}`;

async function aggCacheGet(_env: Env, key: string): Promise<AggCacheEntry | null> {
  const m = aggMem.get(key);
  if (!m) return null;
  if (Date.now() - m.at > AGG_STALE_TTL_S * 1000) {
    aggMem.delete(key);
    return null;
  }
  return m;
}
async function aggCachePut(_env: Env, key: string, e: AggCacheEntry): Promise<void> {
  aggMem.set(key, e);
}
/** Drop every cached aggregate (called after any action-item add/update/delete). */
export async function invalidateAggregateCache(_env: Env): Promise<void> {
  aggMem.clear();
}
/** Test seam. */
export function _clearAggregateCache(): void {
  aggMem.clear();
}

export async function aggregateActionItemsWithMeta(
  env: Env,
  statustype?: "open" | "closed",
  opts: { refresh?: boolean } = {}
): Promise<{ items: DashboardActionItem[]; meta: AggregateMeta }> {
  const key = aggKey(statustype);
  const cached = await aggCacheGet(env, key);
  const now = Date.now();
  if (!opts.refresh && cached && now - cached.at < AGG_FRESH_MS) {
    return { items: cached.items, meta: { ...cached.meta, cached: true, fetchedAt: new Date(cached.at).toISOString() } };
  }

  let result: { items: DashboardActionItem[]; meta: AggregateMeta };
  try {
    result = await aggregateFromZoho(env, statustype);
  } catch (e) {
    // A throttle on the projects list itself: serve whatever we have rather than nothing.
    if (e instanceof ZohoThrottleError && cached) {
      return {
        items: cached.items,
        meta: { ...cached.meta, cached: true, stale: true, throttled: true, retryAfterMin: e.retryAfterMin, fetchedAt: new Date(cached.at).toISOString() },
      };
    }
    throw e;
  }

  if (result.meta.throttled) {
    // Partial result. Prefer the last complete list if we have one; either way say so.
    if (cached) {
      return {
        items: cached.items,
        meta: { ...cached.meta, cached: true, stale: true, throttled: true, retryAfterMin: result.meta.retryAfterMin, fetchedAt: new Date(cached.at).toISOString() },
      };
    }
    return { items: result.items, meta: { ...result.meta, fetchedAt: new Date(now).toISOString() } };
  }

  const entry: AggCacheEntry = { at: now, items: result.items, meta: result.meta };
  await aggCachePut(env, key, entry);
  return { items: result.items, meta: { ...result.meta, fetchedAt: new Date(now).toISOString() } };
}

async function aggregateFromZoho(
  env: Env,
  statustype?: "open" | "closed"
): Promise<{ items: DashboardActionItem[]; meta: AggregateMeta }> {
  // PRIMARY: the v3 projects list carries accurate issue COUNTS (verified 2026-08-31), so query
  // only the SERVICE projects that actually have issues — a handful of subrequests, and immune to
  // any page-cap/ordering issue. This is what makes the dashboard populate.
  const projects = await listServiceProjects(env);
  const byCount = projects.filter((p) => {
    if (statustype === "open") return (p.openIssues ?? 0) > 0;
    if (statustype === "closed") return (p.closedIssues ?? 0) > 0;
    return (p.openIssues ?? 0) + (p.closedIssues ?? 0) > 0;
  });
  const meta: AggregateMeta = { serviceProjects: projects.length, withCounts: byCount.length, path: "counts" };
  if (byCount.length > 0) {
    const q = await queryProjectsForIssues(env, byCount, statustype);
    return { items: q.items, meta: { ...meta, ...q.throttle } };
  }

  // DEFENSIVE FALLBACK (only if no project reports a count): one portal-wide /issues pass; if that
  // errors or is empty, a bounded full scan of every service project.
  try {
    const viaPortal = await aggregateViaPortal(env, statustype);
    if (viaPortal.length > 0) return { items: viaPortal, meta: { ...meta, path: "portal" } };
  } catch (e) {
    if (e instanceof ZohoThrottleError) throw e;
    console.warn("aggregateActionItems: portal-wide fallback failed:", e);
  }
  const q = await queryProjectsForIssues(env, projects, statustype);
  return { items: q.items, meta: { ...meta, path: "scan", ...q.throttle } };
}

/** Portal-wide path: GET /portal/{id}/issues (paginated) → filter to service projects + status. */
async function aggregateViaPortal(
  env: Env,
  statustype?: "open" | "closed"
): Promise<DashboardActionItem[]> {
  const serviceIds = new Set((await listServiceProjects(env)).map((p) => p.id));
  const raw = await listAllPortalIssues(env);
  const out: DashboardActionItem[] = [];
  for (const b of raw) {
    const projId = String(b?.project?.id ?? "");
    if (!serviceIds.has(projId)) continue;
    const item = normalizeIssue(b);
    if (statustype === "open" && item.closed) continue;
    if (statustype === "closed" && !item.closed) continue;
    out.push({ ...item, projectId: projId, projectName: String(b?.project?.name ?? "") });
  }
  return out;
}

/** Query a given set of projects' /bugs with bounded concurrency, tagging each issue's project.
 *  On a Zoho throttle: stop fanning out (every further call would fail too), keep what we have,
 *  and REPORT it — a throttle is not "this project has no items". */
async function queryProjectsForIssues(
  env: Env,
  targets: { id: string; name: string }[],
  statustype?: "open" | "closed"
): Promise<{ items: DashboardActionItem[]; throttle: Pick<AggregateMeta, "throttled" | "retryAfterMin" | "failedProjects"> }> {
  const out: DashboardActionItem[] = [];
  const CONCURRENCY = 6;
  let throttled = false;
  let retryAfterMin = 0;
  const failed: string[] = [];
  for (let i = 0; i < targets.length && !throttled; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          const items = await listActionItems(env, p.id, statustype ? { statustype } : {});
          return items.map((it) => ({ ...it, projectId: p.id, projectName: p.name }));
        } catch (e) {
          failed.push(p.id);
          if (e instanceof ZohoThrottleError) {
            throttled = true;
            retryAfterMin = Math.max(retryAfterMin, e.retryAfterMin);
          } else {
            console.warn(`aggregateActionItems: project ${p.id} issues failed (skipped):`, e);
          }
          return [] as DashboardActionItem[];
        }
      })
    );
    for (const arr of results) out.push(...arr);
    if (throttled) {
      // Everything not yet queried is also "failed" — the window is closed for all of them.
      for (const p of targets.slice(i + CONCURRENCY)) failed.push(p.id);
    }
  }
  return {
    items: out,
    throttle: throttled ? { throttled: true, retryAfterMin, failedProjects: failed } : failed.length ? { failedProjects: failed } : {},
  };
}

/** Delete an action item (issue). Swallows a 404 (already gone). */
export async function deleteActionItem(env: Env, projectId: string, issueId: string): Promise<void> {
  await invalidateAggregateCache(env);
  try {
    await restFetch(env, `${bugsRoot(env, projectId)}/${issueId}/`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof ZohoError && /\b404\b/.test(String(e.message))) return;
    throw e;
  }
}

/** The project's issue STATUS options (for a status dropdown + open/closed mapping). */
export async function listStatuses(env: Env, projectId: string): Promise<ActionItemStatus[]> {
  const data = await restFetch(env, `${bugsRoot(env, projectId)}/defaultfields/`);
  const df = data?.defaultfields ?? {};
  const list: any[] = df.status_details ?? df.status_deatils ?? []; // doc has a typo variant
  // Zoho's classic REST returns these flags as STRINGS ("true"/"false"); Boolean("false") is true,
  // which marked every status closed (verified live 2026-09-02). Parse explicitly.
  const flag = (v: any) => v === true || String(v).toLowerCase() === "true";
  return list.map((st) => ({
    id: String(st?.status_id ?? ""),
    name: String(st?.status_name ?? ""),
    closed: flag(st?.closed),
    isDefault: flag(st?.isdefault),
  }));
}
