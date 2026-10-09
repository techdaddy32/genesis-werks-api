// row: A2-fix4 · run: run-2026-10-07-drawing-layer-09 · 2026-10-09 — POST /diagnostics: a phone reports an error it cannot show; GET /diagnostics lists them (office/admin)
//==============================================================================
// Field devices hit failures the office never sees (a native module throwing on a photo read, say).
// This lets the app post the text as a shared.events row (event_type 'device.diagnostic') so the
// conductor / office can read it. Never on the read path; capped; no bytes.
//==============================================================================
import type { OrganizationContext } from "../org-context";
import { withOrg, withOrgRead } from "../org-context";
import { emitEvent } from "./checkout";

export interface RouteResult { status: number; body: unknown }

const MAX_MESSAGE = 8000;

export async function postDiagnostic(ctx: OrganizationContext, body: unknown): Promise<RouteResult> {
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  const message = typeof b.message === "string" ? b.message.slice(0, MAX_MESSAGE) : "";
  if (!message) return { status: 400, body: { error: "message is required" } };
  const kind = typeof b.kind === "string" ? b.kind.slice(0, 64) : "error";
  const deviceId = typeof b.device_id === "string" ? b.device_id.slice(0, 128) : null;
  const walkId = typeof b.walk_id === "string" ? b.walk_id : null;
  const projectId = typeof b.project_id === "string" ? b.project_id : null;
  const context = b.context && typeof b.context === "object" ? (b.context as Record<string, unknown>) : {};
  const key = `device.diagnostic:${deviceId ?? ctx.actorId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await withOrg(ctx, async (tx) => {
    await emitEvent(tx, ctx, {
      projectId: null, refTable: walkId ? "places.walks" : "shared.members", refId: walkId ?? (ctx.actorId || null), type: "device.diagnostic",
      payload: { kind, message, device_id: deviceId, walk_id: walkId, project_id: projectId, context, app: typeof b.app === "string" ? b.app.slice(0, 200) : null },
      key, deviceId,
    });
  });
  return { status: 201, body: { ok: true } };
}

export async function listDiagnostics(ctx: OrganizationContext, params: URLSearchParams): Promise<RouteResult> {
  if (!(ctx.isAdmin || ctx.role === "office" || ctx.role === "designer" || ctx.role === "admin")) return { status: 403, body: { error: "office / admin only" } };
  const limit = Math.min(Math.max(Number(params.get("limit") ?? "50") || 50, 1), 200);
  const rows = await withOrgRead(ctx, async (tx) =>
    tx<{ id: string; occurred_at: string; actor: string | null; device_id: string | null; payload: Record<string, unknown> }[]>`
      select id, occurred_at, actor, device_id, payload from shared.events
       where organization_id = ${ctx.organizationId} and event_type = 'device.diagnostic'
       order by occurred_at desc limit ${limit}`
  );
  return { status: 200, body: { diagnostics: rows } };
}
