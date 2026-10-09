// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09 — GET /projects/:id/history (LV parity: the project's event stream, newest first)
//==============================================================================
// sync/history.ts — GET /projects/:id/history?since=<ISO>&limit=<1..500>
//
// shared.events is the history (Gate B: revision is a counter, event stamps are the history).
// Returned: events with project_id = the project, PLUS events raised on the project's drawings
// and walks whose project_id was NULL at the time (e.g. a drawing copied before attach, a draft
// walk's captures before POST /walks/:id/attach). Newest first; `since` = occurred_at > since.
// Any member of the Organization may read it. → 200 {project_id, events: [{id, kind, occurred_at,
// actor_id, actor_type, ref_table, ref_id, payload}], next_since, truncated}
//==============================================================================

import type { OrganizationContext } from "../org-context";
import { withOrgRead } from "../org-context";
import { isUuid } from "../db";
import type { RouteResult } from "./checkout";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface HistoryEvent {
  id: string;
  kind: string;
  occurred_at: Date;
  actor_id: string | null;
  actor_type: string;
  ref_table: string;
  ref_id: string | null;
  payload: Record<string, unknown>;
}

export async function projectHistory(ctx: OrganizationContext, projectId: string, params: URLSearchParams): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  const pid = projectId.toLowerCase();
  const sinceRaw = (params.get("since") ?? "").trim();
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) return { status: 400, body: { error: "since must be an ISO-8601 timestamp" } };
  // `since` travels as TEXT (microsecond precision survives; a JS Date would round to ms and re-deliver the boundary row)
  const since = sinceRaw || null;
  const limitRaw = params.get("limit");
  const limit = limitRaw == null || limitRaw.trim() === "" ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { status: 400, body: { error: `limit must be an integer in [1, ${MAX_LIMIT}]` } };
  const org = ctx.organizationId;

  return withOrgRead(ctx, async (tx) => {
    const p = await tx<{ id: string }[]>`select id from shared.projects where id = ${pid} and organization_id = ${org} and deleted_at is null`;
    if (!p[0]) return { status: 404, body: { error: "project not found in this organization" } };
    const rows = await tx<HistoryEvent[]>`
      select e.id, e.event_type as kind, e.occurred_at, e.actor as actor_id, e.actor_type, e.ref_table, e.ref_id, e.payload,
             to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _cursor
        from shared.events e
       where e.organization_id = ${org}
         and (e.project_id = ${pid}
              or (e.ref_table = 'drawings.drawings' and e.ref_id in (select id from drawings.drawings where organization_id = ${org} and project_id = ${pid}))
              or (e.ref_table = 'places.walks' and e.ref_id in (select id from places.walks where organization_id = ${org} and project_id = ${pid})))
         ${since ? tx`and e.occurred_at > ${since}::text::timestamptz` : tx``}
       order by e.occurred_at desc, e.id desc
       limit ${limit + 1}`;
    const truncated = rows.length > limit;
    const events = truncated ? rows.slice(0, limit) : rows;
    const newest = (events[0] as (HistoryEvent & { _cursor?: string }) | undefined)?._cursor ?? since;
    for (const e of events) delete (e as HistoryEvent & { _cursor?: string })._cursor;
    return { status: 200, body: { project_id: pid, since, next_since: newest ?? null, limit, truncated, events } };
  });
}
