// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W3 · run: run-2026-10-07-drawing-layer-05 · 2026-10-07 — annotations carry layer_ordinal and are returned in render order (layer ordinal, z, received_at)
//==============================================================================
// sync/pull.ts — GET /sync/pull?project_id=<uuid>&since=<ISO timestamptz>
//
// Returns, for ONE project (the spine), rows the device should upsert locally:
//   structure : rooms, locations, device_placements(plan), wire_runs, room_polygons,
//               location_placements, drawings (+ their pages, layers)
//   captures  : walks, location_notes, location_media, device_placements(as_walked),
//               annotations, files
// Every table is filtered by `received_at > since` when `since` is given — this is a
// PER-ROW INCREMENTAL feed (L4: never a whole-project replace). Tombstones
// (deleted_at NOT NULL) are returned like any other row so the device tombstones
// locally. `since` omitted = the initial checkout snapshot, still delivered row by
// row. `next_since` = the greatest received_at in this response (or the given
// `since`) — pass it back next time.
//
// "Published structure": the schema keeps NO per-row published/working marker and NO
// layout history (Craig, Gate B — revision is a counter, event stamps are the
// history), so the structure rows returned are the CURRENT rows, labelled with
// structure_state.published_revision / working_revision / published_drawing_version_id.
// Rows edited after the last publish are therefore visible to a pulling device; the
// publish gate governs when the designer CHECKS IN, not a second copy of the rows.
// (Flagged in the W1 report as a §5.7 interpretation.)
//
// Captures: a technician's rows reach the server only when that technician syncs, so
// "others' unsynced captures" are never here by construction; once received they are
// returned to every member of the Organization (spec §5.3 R-capture).
//
// Draft walks (project_id NULL) are not project-scoped and pull nothing here.
//
// W3 render order (spec §5.5): layers come with ordinal / locked / export / class / write_policy
// (every column); annotations come with z, layer_id, redirected_from_layer_id AND a joined
// `layer_ordinal`, and the page returned is sorted (layer ordinal, z, received_at). The DB query
// still fetches by received_at so the cursor / truncation stay correct; the sort is applied to
// the fetched page.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrgRead } from "../org-context";
import { isUuid } from "../db";
import type { JsonRow } from "./tables";

const PAGE = 1000;

export interface PullQuery {
  project_id: string;
  /** ISO-8601 as given (passed to Postgres as text so microsecond precision survives). */
  since: string | null;
}

export class PullQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullQueryError";
  }
}

export function parsePullQuery(params: URLSearchParams): PullQuery {
  const project = (params.get("project_id") ?? "").trim().toLowerCase();
  if (!isUuid(project)) throw new PullQueryError("project_id (uuid) is required");
  const sinceRaw = params.get("since");
  let since: string | null = null;
  if (sinceRaw != null && sinceRaw.trim() !== "") {
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/.test(sinceRaw.trim()) || Number.isNaN(Date.parse(sinceRaw))) {
      throw new PullQueryError("since must be an ISO-8601 timestamp");
    }
    since = sinceRaw.trim();
  }
  return { project_id: project, since };
}

export interface PullResult {
  project_id: string;
  since: string | null;
  next_since: string | null;
  server_time: string;
  structure_state: {
    working_revision: number;
    published_revision: number;
    published_drawing_version_id: string | null;
    published_at: string | null;
    checkout_user_id: string | null;
    checkout_expires_at: string | null;
  } | null;
  structure: Record<string, JsonRow[]>;
  captures: Record<string, JsonRow[]>;
  /** Tables whose page limit was hit — pull again with next_since to continue. */
  truncated: string[];
}

export async function pullProject(ctx: OrganizationContext, q: PullQuery): Promise<PullResult | null> {
  return withOrgRead(ctx, async (tx) => {
    const org = ctx.organizationId;
    const project = await tx<{ id: string }[]>`select id from shared.projects where id = ${q.project_id} and organization_id = ${org} and deleted_at is null`;
    if (project.length === 0) return null;

    const stateRows = await tx<{
      working_revision: number; published_revision: number; published_drawing_version_id: string | null;
      published_at: Date | null; checkout_user_id: string | null; checkout_expires_at: Date | null;
    }[]>`
      select working_revision, published_revision, published_drawing_version_id, published_at, checkout_user_id, checkout_expires_at
        from places.structure_state where project_id = ${q.project_id} and organization_id = ${org}`;
    const st = stateRows[0] ?? null;

    const since = q.since;
    const truncated: string[] = [];
    // Cursor at MICROSECOND precision (received_at is timestamptz(6); a JS Date would round to ms
    // and re-deliver boundary rows). Every query also selects `_cursor` = received_at as text in UTC.
    let maxCursor: string | null = since ? toCursor(since) : null;
    const track = (name: string, rows: JsonRow[]): JsonRow[] => {
      if (rows.length > PAGE) { truncated.push(name); rows = rows.slice(0, PAGE); }
      for (const r of rows) {
        const c = r._cursor as string;
        delete r._cursor;
        if (c && (!maxCursor || c > maxCursor)) maxCursor = c;
      }
      return rows;
    };
    // `received_at > since` or no filter; LIMIT PAGE+1 to detect truncation.
    // `::text::timestamptz`: the server would otherwise type the parameter as timestamptz and the
    // driver would run its Date serializer on the string (truncating to milliseconds).
    const sinceSql = (tx: Tx, alias: string) => (since ? tx`and ${tx(alias)}.received_at > ${since}::text::timestamptz` : tx``);
    const cursorSql = (tx: Tx, alias: string) => tx`to_char(${tx(alias)}.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _cursor`;

    const byProject = async (table: string, extra?: (tx: Tx) => ReturnType<Tx>): Promise<JsonRow[]> =>
      track(table, await tx<JsonRow[]>`
        select t.*, ${cursorSql(tx, "t")} from ${tx(table)} t
         where t.organization_id = ${org} and t.project_id = ${q.project_id} ${sinceSql(tx, "t")} ${extra ? extra(tx) : tx``}
         order by t.received_at, t.id limit ${PAGE + 1}`);

    const viaDrawing = async (table: string): Promise<JsonRow[]> =>
      track(table, await tx<JsonRow[]>`
        select t.*, ${cursorSql(tx, "t")} from ${tx(table)} t join drawings.drawings d on d.id = t.drawing_id
         where t.organization_id = ${org} and d.organization_id = ${org} and d.project_id = ${q.project_id} ${sinceSql(tx, "t")}
         order by t.received_at, t.id limit ${PAGE + 1}`);

    const structure: Record<string, JsonRow[]> = {
      "places.rooms": await byProject("places.rooms"),
      "places.locations": await byProject("places.locations"),
      "places.device_placements": await byProject("places.device_placements", (s) => s`and t.capture_kind = 'plan'`),
      "places.wire_runs": await byProject("places.wire_runs"),
      "places.room_polygons": await byProject("places.room_polygons"),
      "places.location_placements": await byProject("places.location_placements"),
      "drawings.drawings": await byProject("drawings.drawings"),
      "drawings.pages": await viaDrawing("drawings.pages"),
      "drawings.layers": await viaDrawing("drawings.layers"),
    };
    const captures: Record<string, JsonRow[]> = {
      "places.walks": await byProject("places.walks"),
      "places.location_notes": await byProject("places.location_notes"),
      "places.location_media": await byProject("places.location_media"),
      "places.device_placements": await byProject("places.device_placements", (s) => s`and t.capture_kind = 'as_walked'`),
      "drawings.annotations": renderOrder(track("drawings.annotations", await tx<JsonRow[]>`
        select a.*, l.ordinal as layer_ordinal, ${cursorSql(tx, "a")} from drawings.annotations a
          join drawings.pages p on p.id = a.page_id
          join drawings.drawings d on d.id = p.drawing_id
          join drawings.layers l on l.id = a.layer_id
         where a.organization_id = ${org} and d.organization_id = ${org} and d.project_id = ${q.project_id} ${sinceSql(tx, "a")}
         order by a.received_at, a.id limit ${PAGE + 1}`)),
      "shared.files": await byProject("shared.files"),
    };

    return {
      project_id: q.project_id,
      since,
      next_since: maxCursor,
      server_time: new Date().toISOString(),
      structure_state: st
        ? {
            working_revision: st.working_revision,
            published_revision: st.published_revision,
            published_drawing_version_id: st.published_drawing_version_id,
            published_at: st.published_at ? st.published_at.toISOString() : null,
            checkout_user_id: st.checkout_user_id,
            checkout_expires_at: st.checkout_expires_at ? st.checkout_expires_at.toISOString() : null,
          }
        : null,
      structure,
      captures,
      truncated,
    };
  });
}

/** W3: render order = layer ordinal, then z within the layer, ties by received_at (spec §5.5). */
export function renderOrder(rows: JsonRow[]): JsonRow[] {
  const ts = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : 0);
  return rows.sort((a, b) =>
    Number(a.layer_ordinal) - Number(b.layer_ordinal) ||
    Number(a.z) - Number(b.z) ||
    ts(a.received_at) - ts(b.received_at) ||
    String(a.id).localeCompare(String(b.id)));
}

/** Normalise a caller's ISO string to the cursor's text form (UTC, 6 fractional digits) for comparison. */
function toCursor(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const frac = (m[3] ?? "").padEnd(6, "0");
  if (m[4] === "Z" || m[4] === "+00:00" || m[4] === "+0000") return `${m[1]}T${m[2]}.${frac}Z`;
  // Non-UTC offset: shift to UTC at ms precision, keep the sub-ms digits.
  const d = new Date(`${m[1]}T${m[2]}.${frac.slice(0, 3)}${m[4]}`);
  return d.toISOString().replace(/\.(\d{3})Z$/, `.$1${frac.slice(3)}Z`);
}
