// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
//==============================================================================
// sync/routes.ts — HTTP glue for the walk-tool sync routes (new schema, 001→090).
//
//   POST /sync/push                  body per push.ts → 200 {accepted, rejected, files}
//   GET  /sync/pull?project_id&since → 200 pull.ts result · 404 unknown project
//   PUT  /sync/files/:id             bytes for a 'pending' file row (files.ts)
//
// Mounted by src/index.ts ONLY when env.SYNC_ROUTES === "on" (the sandbox deployment).
// backend-mode.ts keys on the tenant-era public.tenant_settings table, which does not
// exist in the new schema, so a plain env flag gates these routes instead (W1 report).
// /sync/calendar (FHI/Zoho reconcile) is NOT handled here and keeps its old handler.
//
// Auth: resolveOrganizationContext (org-context.ts). Every DB touch below goes through
// withOrg/withOrgRead — there is no other path.
//==============================================================================

import type { Env } from "../types";
import { resolveOrganizationContext, OrgContextError, type OrganizationContext, type Authenticator } from "../org-context";
import { parsePushBody, pushBatch, PushBodyError } from "./push";
import { parsePullQuery, pullProject, PullQueryError } from "./pull";
import { putUrlFor, receiveFileBytes } from "./files";

export interface SyncResponse {
  status: number;
  body: unknown;
}

export interface SyncRouteOptions {
  /** Override the authenticator (tests / JWT). */
  authenticate?: Authenticator;
}

/** True for the paths this module owns (never /sync/calendar). */
export function isSyncPath(path: string): boolean {
  return path === "/sync/push" || path === "/sync/pull" || path.startsWith("/sync/files/");
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

  if (path === "/sync/push") {
    if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
    let parsed;
    try {
      parsed = parsePushBody(await readJson(request));
    } catch (e) {
      if (e instanceof PushBodyError) return { status: 400, body: { error: e.message } };
      throw e;
    }
    const origin = new URL(request.url).origin;
    const result = await pushBatch(ctx, parsed, { putUrlFor: putUrlFor(origin) });
    return { status: 200, body: result };
  }

  if (path === "/sync/pull") {
    if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
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

  // /sync/files/:id
  if (method !== "PUT") return { status: 405, body: { error: "method not allowed" } };
  const fileId = path.slice("/sync/files/".length);
  const r = await receiveFileBytes(ctx, env.FILES, fileId, request);
  return { status: r.status, body: r.body };
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
