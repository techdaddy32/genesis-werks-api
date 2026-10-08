// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07 — checkout / review / publish / attach / files routes
// row: W3 · run: run-2026-10-07-drawing-layer-05 · 2026-10-07 — layer CRUD routes (GET/POST /drawings/:id/layers · PATCH/DELETE /drawings/:id/layers/:layerId)
// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08 — drawings attach/detach/move/copy · PATCH /annotations/:id (R-move) · version lifecycle (list / transition / compare)
//==============================================================================
// sync/routes.ts — HTTP glue for the walk-tool routes (new schema, 001→090).
//
//   W1
//   POST  /sync/push                          body per push.ts → 200 {accepted, rejected, files}
//   GET   /sync/pull?project_id&since         → 200 pull.ts result · 404 unknown project
//   PUT   /sync/files/:id                     bytes for a 'pending' file row (files.ts)
//   W2
//   POST  /projects/:id/checkout              {device_id?} → 200 {op, structure_state} · 409 held by another
//   POST  /projects/:id/checkout/renew        → 200 · 403 not holder · 409 none/expired
//   POST  /projects/:id/checkout/release      → 200 · 403 not holder/admin
//   POST  /projects/:id/checkout/override     ADMIN → 200 · 403 otherwise (event checkout.overridden)
//   GET   /projects/:id/review                → 200 {groups[], action_items[], context{}}
//   PATCH /projects/:id/review/:changeId      {outcome} → 200 · 409 already published
//   POST  /projects/:id/publish               {drawing_version_id?} → 200 {structure_state} · 409 pending/no checkout · 403 not holder
//   POST  /walks/:id/attach                   {project_id} → 200 {resolved_rooms, room_hint_pending} · 409 other project
//   POST  /files                              {filename, kind?, …} → 201 {file_id, storage_key, put_url}
//   POST  /files/:id/uploaded                 {sha256, byte_size?} → 200
//   W3 (sync/layers.ts)
//   GET    /drawings/:id/layers               → 200 {drawing_id, layers[]} (render order)
//   POST   /drawings/:id/layers               {name, class, write_policy, export?, ordinal?, color_hint?} → 201 · 400 · 403 technician
//   PATCH  /drawings/:id/layers/:layerId      {name?, ordinal?, export?, color_hint?, locked?} → 200 · 400 class/write_policy · 403 (designer: export/locked)
//   DELETE /drawings/:id/layers/:layerId      tombstone (office/admin) → 200 · 403 · 409 referenced by live annotations
//   W4 (sync/drawings.ts · sync/versions.ts · review.ts publish pin)
//   POST   /drawings/:id/attach               {project_id | account_id} (office/admin) → 200 {resolved_rooms, room_hint_pending, annotation_proposals} · 400 not exactly one · 409 attached elsewhere
//   POST   /drawings/:id/detach               (office/admin) → 200 {withdrawn_changes, rows_rewritten} (in place; zero deletes)
//   POST   /drawings/:id/move                 {project_id | account_id} = detach + attach, one transaction → 200
//   POST   /drawings/:id/copy                 {title?} (designer/office/admin) → 201 {drawing, counts, layers/versions/pages id maps}
//   PATCH  /annotations/:id                   {layer_id} same class → 200 moved · onto structure = promotion (live checkout) → 201 {annotation, source} · 403 / 409
//   GET    /drawings/:id/versions             → 200 {drawing_id, versions[{…, latest_transition}]} · 409 whiteboard
//   POST   /drawing-versions/:id/transition   {to, note?, client_name?, client_at?} → 200 {from, to, version, transition, superseded[]} · 400 · 403 role · 409 edge / whiteboard
//   GET    /drawing-versions/:a/compare/:b    → 200 {a, b, pages[], changes[], summary} · 409 different drawings / whiteboard
//   POST   /projects/:id/publish              (W2) now also: 404 unknown drawing_version_id · 409 version of another project / client_rejected / superseded
//
// Mounted by src/index.ts ONLY when env.SYNC_ROUTES === "on" (the sandbox deployment), AFTER
// the tenant-era /projects/:pid/(membership|forum-categories|action-items|forums) routes, which
// keep their old handlers — none of the paths above collide with them. /sync/calendar is not here.
//
// Auth: resolveOrganizationContext (org-context.ts). Every DB touch below goes through
// withOrg/withOrgRead — there is no other path.
//==============================================================================

import type { Env } from "../types";
import { resolveOrganizationContext, OrgContextError, type OrganizationContext, type Authenticator } from "../org-context";
import { parsePushBody, pushBatch, PushBodyError } from "./push";
import { parsePullQuery, pullProject, PullQueryError } from "./pull";
import { putUrlFor, receiveFileBytes, createFile, markUploaded } from "./files";
import { takeCheckout, renewCheckout, releaseCheckout, overrideCheckout } from "./checkout";
import { getReview, patchReview, publishProject } from "./review";
import { attachWalk } from "./attach";
import { listLayers, createLayer, patchLayer, tombstoneLayer } from "./layers";
import { attachDrawing, detachDrawing, moveDrawing, copyDrawing, moveAnnotation } from "./drawings";
import { listVersions, transitionVersion, compareVersions } from "./versions";

export interface SyncResponse {
  status: number;
  body: unknown;
}

export interface SyncRouteOptions {
  /** Override the authenticator (tests / JWT). */
  authenticate?: Authenticator;
}

const RE_CHECKOUT = /^\/projects\/([^/]+)\/checkout(?:\/(renew|release|override))?$/;
const RE_REVIEW = /^\/projects\/([^/]+)\/review(?:\/([^/]+))?$/;
const RE_PUBLISH = /^\/projects\/([^/]+)\/publish$/;
const RE_WALK_ATTACH = /^\/walks\/([^/]+)\/attach$/;
const RE_FILE_UPLOADED = /^\/files\/([^/]+)\/uploaded$/;
const RE_LAYERS = /^\/drawings\/([^/]+)\/layers(?:\/([^/]+))?$/;
const RE_DRAWING_ACT = /^\/drawings\/([^/]+)\/(attach|detach|move|copy)$/;
const RE_DRAWING_VERSIONS = /^\/drawings\/([^/]+)\/versions$/;
const RE_ANNOTATION = /^\/annotations\/([^/]+)$/;
const RE_VERSION_TRANSITION = /^\/drawing-versions\/([^/]+)\/transition$/;
const RE_VERSION_COMPARE = /^\/drawing-versions\/([^/]+)\/compare\/([^/]+)$/;

/** True for the paths this module owns (never /sync/calendar, never the tenant-era /projects routes). */
export function isSyncPath(path: string): boolean {
  return (
    path === "/sync/push" || path === "/sync/pull" || path.startsWith("/sync/files/") ||
    RE_CHECKOUT.test(path) || RE_REVIEW.test(path) || RE_PUBLISH.test(path) || RE_WALK_ATTACH.test(path) ||
    path === "/files" || RE_FILE_UPLOADED.test(path) || RE_LAYERS.test(path) ||
    RE_DRAWING_ACT.test(path) || RE_DRAWING_VERSIONS.test(path) || RE_ANNOTATION.test(path) ||
    RE_VERSION_TRANSITION.test(path) || RE_VERSION_COMPARE.test(path)
  );
}

/** Returns null when `path` is not a sync route; otherwise a {status, body} for index.ts' json(). */
export async function handleSyncRoute(request: Request, env: Env, path: string, method: string, opts: SyncRouteOptions = {}): Promise<SyncResponse | null> {
  if (!isSyncPath(path)) return null;

  let ctx: OrganizationContext;
  try {
    ctx = await resolveOrganizationContext(request, env, { authenticate: opts.authenticate });
  } catch (e) {
    if (e instanceof OrgContextError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
  const origin = new URL(request.url).origin;
  const notAllowed: SyncResponse = { status: 405, body: { error: "method not allowed" } };

  if (path === "/sync/push") {
    if (method !== "POST") return notAllowed;
    let parsed;
    try {
      parsed = parsePushBody(await readJson(request));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
    const result = await pushBatch(ctx, parsed, { putUrlFor: putUrlFor(origin) });
    return { status: 200, body: result };
  }

  if (path === "/sync/pull") {
    if (method !== "GET") return notAllowed;
    let q;
    try {
      q = parsePullQuery(new URL(request.url).searchParams);
    } catch (e) {
      if (e instanceof PullQueryError) return { status: 400, body: { error: e.message } };
      throw e;
    }
    const result = await pullProject(ctx, q);
    if (!result) return { status: 404, body: { error: "project not found in this organization" } };
    return { status: 200, body: result };
  }

  if (path.startsWith("/sync/files/")) {
    if (method !== "PUT") return notAllowed;
    const fileId = path.slice("/sync/files/".length);
    return receiveFileBytes(ctx, env.FILES, fileId, request);
  }

  // --- W2 -----------------------------------------------------------------------------
  let m: RegExpExecArray | null;

  if ((m = RE_CHECKOUT.exec(path))) {
    if (method !== "POST") return notAllowed;
    const projectId = m[1];
    const action = m[2];
    if (!action) return takeCheckout(ctx, projectId, await readJsonOrEmpty(request));
    if (action === "renew") return renewCheckout(ctx, projectId);
    if (action === "release") return releaseCheckout(ctx, projectId);
    return overrideCheckout(ctx, projectId, await readJsonOrEmpty(request));
  }

  if ((m = RE_REVIEW.exec(path))) {
    const projectId = m[1];
    const changeId = m[2];
    if (!changeId) {
      if (method !== "GET") return notAllowed;
      return getReview(ctx, projectId);
    }
    if (method !== "PATCH") return notAllowed;
    try {
      return await patchReview(ctx, projectId, changeId, await readJson(request));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }

  if ((m = RE_PUBLISH.exec(path))) {
    if (method !== "POST") return notAllowed;
    return publishProject(ctx, m[1], await readJsonOrEmpty(request));
  }

  if ((m = RE_WALK_ATTACH.exec(path))) {
    if (method !== "POST") return notAllowed;
    try {
      return await attachWalk(ctx, m[1], await readJson(request));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }

  if (path === "/files") {
    if (method !== "POST") return notAllowed;
    try {
      return await createFile(ctx, await readJson(request), putUrlFor(origin));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }

  if ((m = RE_FILE_UPLOADED.exec(path))) {
    if (method !== "POST") return notAllowed;
    try {
      return await markUploaded(ctx, m[1], await readJson(request));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }

  // --- W3 -----------------------------------------------------------------------------
  if ((m = RE_LAYERS.exec(path))) {
    const drawingId = m[1];
    const layerId = m[2];
    try {
      if (!layerId) {
        if (method === "GET") return await listLayers(ctx, drawingId);
        if (method === "POST") return await createLayer(ctx, drawingId, await readJson(request) as Record<string, unknown>);
        return notAllowed;
      }
      if (method === "PATCH") return await patchLayer(ctx, drawingId, layerId, await readJson(request) as Record<string, unknown>);
      if (method === "DELETE") return await tombstoneLayer(ctx, drawingId, layerId);
      return notAllowed;
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }

  // --- W4 -----------------------------------------------------------------------------
  if ((m = RE_DRAWING_ACT.exec(path))) {
    if (method !== "POST") return notAllowed;
    const drawingId = m[1];
    const act = m[2];
    const body = await readJsonOrEmpty(request);
    if (act === "attach") return attachDrawing(ctx, drawingId, body);
    if (act === "detach") return detachDrawing(ctx, drawingId);
    if (act === "move") return moveDrawing(ctx, drawingId, body);
    return copyDrawing(ctx, drawingId, body);
  }

  if ((m = RE_DRAWING_VERSIONS.exec(path))) {
    if (method !== "GET") return notAllowed;
    return listVersions(ctx, m[1]);
  }

  if ((m = RE_ANNOTATION.exec(path))) {
    if (method !== "PATCH") return notAllowed;
    try {
      return await moveAnnotation(ctx, m[1], await readJson(request));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }

  if ((m = RE_VERSION_TRANSITION.exec(path))) {
    if (method !== "POST") return notAllowed;
    try {
      return await transitionVersion(ctx, m[1], await readJson(request));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }

  if ((m = RE_VERSION_COMPARE.exec(path))) {
    if (method !== "GET") return notAllowed;
    return compareVersions(ctx, m[1], m[2]);
  }

  return null;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) throw new PushBodyError("body must be JSON");
  try {
    return JSON.parse(text);
  } catch {
    throw new PushBodyError("body must be JSON");
  }
}

/** For routes whose body is optional: empty → {}, malformed → {} too (fields are all optional). */
async function readJsonOrEmpty(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
