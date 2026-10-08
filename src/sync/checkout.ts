// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
//==============================================================================
// sync/checkout.ts — the designer checkout lease on places.structure_state (walk spec
// L6, §5.2, §5.6; 036 column-level UPDATE grant covers exactly these columns).
//
//   POST /projects/:id/checkout            take (designer or admin). 409 while another member
//                                          holds an unexpired lease. Re-take by the holder = renew.
//   POST /projects/:id/checkout/renew      holder only → expires_at = now() + lease
//   POST /projects/:id/checkout/release    holder (or admin) → all checkout_* NULL
//   POST /projects/:id/checkout/override   ADMIN ONLY → the admin TAKES the lease; writes
//                                          checkout_override_by/at; event checkout.overridden.
//                                          This is the only admin path around a checkout —
//                                          /sync/push has no admin bypass (Craig, 2026-10-07).
//
// Lease length = org_settings 'designer_lease' (default 24h); warn-before = 'designer_lease_warn'
// (default 1h). Values: a number (seconds) or a string "24h" | "90m" | "1d" | "3600s" | "HH:MM:SS"
// | a Postgres-style "24 hours" / "1 day" / "90 minutes". Anything unparseable → the default
// (logged in the response as lease_source = "default").
//
// sweepLeaseWarnings(ctx) — cron: for every live lease inside the warn window, ONE
// `checkout.expiring` event per lease (idempotency_key keyed by project + expires_at, so a
// renew — which moves expires_at — earns a fresh warning and a plain re-run does not).
//
// Every statement goes through withOrg (SET LOCAL app.org_id); every UPDATE filters
// organization_id explicitly as well. Rules live here in TypeScript, none in PL/pgSQL.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";

export interface StructureStateRow {
  project_id: string;
  organization_id: string;
  working_revision: number;
  published_revision: number;
  published_drawing_version_id: string | null;
  checkout_user_id: string | null;
  checkout_device_id: string | null;
  checkout_at: Date | null;
  checkout_expires_at: Date | null;
  checkout_override_by: string | null;
  checkout_override_at: Date | null;
  published_at: Date | null;
  published_by: string | null;
}

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

export const DEFAULT_LEASE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WARN_MS = 60 * 60 * 1000;

//------------------------------------------------------------------------------
// Lease settings
//------------------------------------------------------------------------------

export interface LeaseSettings {
  leaseMs: number;
  warnMs: number;
  leaseSource: "org_settings" | "default";
  warnSource: "org_settings" | "default";
}

/** Parse an org_settings value into milliseconds; null when it cannot be read. Exported for tests. */
export function parseDurationMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value * 1000); // seconds
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  let m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Math.round(n * mult);
  }
  m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) * 1000;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  return null;
}

export async function readLeaseSettings(tx: Tx, organizationId: string): Promise<LeaseSettings> {
  const rows = await tx<{ key: string; value: unknown }[]>`
    select key, value from shared.org_settings
     where organization_id = ${organizationId} and key in ('designer_lease', 'designer_lease_warn')`;
  const lease = parseDurationMs(rows.find((r) => r.key === "designer_lease")?.value);
  const warn = parseDurationMs(rows.find((r) => r.key === "designer_lease_warn")?.value);
  return {
    leaseMs: lease ?? DEFAULT_LEASE_MS,
    warnMs: warn ?? DEFAULT_WARN_MS,
    leaseSource: lease == null ? "default" : "org_settings",
    warnSource: warn == null ? "default" : "org_settings",
  };
}

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

export async function lockStructureState(tx: Tx, projectId: string, organizationId: string): Promise<StructureStateRow | null> {
  const rows = await tx<StructureStateRow[]>`
    select * from places.structure_state where project_id = ${projectId} and organization_id = ${organizationId} for update`;
  return rows[0] ?? null;
}

export async function readStructureState(tx: Tx, projectId: string, organizationId: string): Promise<StructureStateRow | null> {
  const rows = await tx<StructureStateRow[]>`
    select * from places.structure_state where project_id = ${projectId} and organization_id = ${organizationId}`;
  return rows[0] ?? null;
}

export function isLive(state: StructureStateRow, now = Date.now()): boolean {
  return !!state.checkout_user_id && !!state.checkout_expires_at && state.checkout_expires_at.getTime() > now;
}

export function stateView(s: StructureStateRow, settings?: LeaseSettings): Record<string, unknown> {
  return {
    project_id: s.project_id,
    working_revision: s.working_revision,
    published_revision: s.published_revision,
    published_drawing_version_id: s.published_drawing_version_id,
    published_at: s.published_at,
    published_by: s.published_by,
    checkout_user_id: s.checkout_user_id,
    checkout_device_id: s.checkout_device_id,
    checkout_at: s.checkout_at,
    checkout_expires_at: s.checkout_expires_at,
    checkout_override_by: s.checkout_override_by,
    checkout_override_at: s.checkout_override_at,
    ...(settings ? { lease_ms: settings.leaseMs, warn_ms: settings.warnMs, lease_source: settings.leaseSource } : {}),
  };
}

export async function emitEvent(
  tx: Tx,
  ctx: OrganizationContext,
  e: { projectId: string | null; refTable: string; refId: string | null; type: string; payload: Record<string, unknown>; key: string; deviceId?: string | null }
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    insert into shared.events (organization_id, project_id, ref_table, ref_id, event_type, payload, actor, actor_type, device_id, idempotency_key)
    values (${ctx.organizationId}, ${e.projectId}, ${e.refTable}, ${e.refId}, ${e.type}, ${tx.json(e.payload as never)},
            ${ctx.actorId || null}, ${ctx.actorId ? "member" : "system"}, ${e.deviceId ?? null}, ${e.key})
    on conflict (organization_id, idempotency_key) do nothing
    returning id`;
  return rows.length === 1;
}

/** Who may hold a checkout: designers and admins (office/technician cannot). */
export function mayCheckout(ctx: OrganizationContext): boolean {
  return ctx.isAdmin || ctx.role === "designer" || ctx.role === "admin";
}

//------------------------------------------------------------------------------
// Routes
//------------------------------------------------------------------------------

export interface CheckoutBody {
  device_id?: string | null;
}

export async function takeCheckout(ctx: OrganizationContext, projectId: string, body: CheckoutBody): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayCheckout(ctx)) return { status: 403, body: { error: "only a designer (or admin) may take the structure checkout" } };
  const deviceId = typeof body.device_id === "string" && body.device_id.trim() ? body.device_id.trim() : null;

  return withOrg(ctx, async (tx) => {
    const state = await lockStructureState(tx, projectId.toLowerCase(), ctx.organizationId);
    if (!state) return { status: 404, body: { error: "project not found in this organization (no structure_state)" } };
    const now = Date.now();
    if (isLive(state, now) && state.checkout_user_id !== ctx.actorId) {
      return {
        status: 409,
        body: { error: "checkout is held by another member", holder: state.checkout_user_id, checkout_expires_at: state.checkout_expires_at, structure_state: stateView(state) },
      };
    }
    const settings = await readLeaseSettings(tx, ctx.organizationId);
    const renewing = isLive(state, now) && state.checkout_user_id === ctx.actorId;
    const checkoutAt = renewing && state.checkout_at ? state.checkout_at : new Date(now);
    const expires = new Date(now + settings.leaseMs);
    const rows = await tx<StructureStateRow[]>`
      update places.structure_state
         set checkout_user_id = ${ctx.actorId}, checkout_device_id = ${deviceId ?? state.checkout_device_id},
             checkout_at = ${checkoutAt}, checkout_expires_at = ${expires}
       where project_id = ${state.project_id} and organization_id = ${ctx.organizationId}
       returning *`;
    const updated = rows[0];
    const previous = state.checkout_user_id && !renewing ? { previous_holder: state.checkout_user_id, previous_expires_at: state.checkout_expires_at } : {};
    await emitEvent(tx, ctx, {
      projectId: state.project_id, refTable: "places.structure_state", refId: state.project_id,
      type: renewing ? "checkout.renewed" : "checkout.taken",
      payload: { holder: ctx.actorId, device_id: deviceId, checkout_expires_at: expires.toISOString(), lease_ms: settings.leaseMs, ...previous },
      key: `places.structure_state:${state.project_id}:${renewing ? "checkout.renewed" : "checkout.taken"}:${now}`,
      deviceId,
    });
    return { status: 200, body: { op: renewing ? "renewed" : "taken", structure_state: stateView(updated, settings) } };
  });
}

export async function renewCheckout(ctx: OrganizationContext, projectId: string): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  return withOrg(ctx, async (tx) => {
    const state = await lockStructureState(tx, projectId.toLowerCase(), ctx.organizationId);
    if (!state) return { status: 404, body: { error: "project not found in this organization (no structure_state)" } };
    if (!state.checkout_user_id) return { status: 409, body: { error: "no checkout to renew", structure_state: stateView(state) } };
    if (state.checkout_user_id !== ctx.actorId) return { status: 403, body: { error: "only the checkout holder may renew", holder: state.checkout_user_id } };
    if (!isLive(state)) return { status: 409, body: { error: "checkout has expired; take it again", structure_state: stateView(state) } };
    const settings = await readLeaseSettings(tx, ctx.organizationId);
    const now = Date.now();
    const expires = new Date(now + settings.leaseMs);
    const rows = await tx<StructureStateRow[]>`
      update places.structure_state set checkout_expires_at = ${expires}
       where project_id = ${state.project_id} and organization_id = ${ctx.organizationId} returning *`;
    await emitEvent(tx, ctx, {
      projectId: state.project_id, refTable: "places.structure_state", refId: state.project_id, type: "checkout.renewed",
      payload: { holder: ctx.actorId, checkout_expires_at: expires.toISOString(), lease_ms: settings.leaseMs },
      key: `places.structure_state:${state.project_id}:checkout.renewed:${now}`,
    });
    return { status: 200, body: { op: "renewed", structure_state: stateView(rows[0], settings) } };
  });
}

export async function releaseCheckout(ctx: OrganizationContext, projectId: string): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  return withOrg(ctx, async (tx) => {
    const state = await lockStructureState(tx, projectId.toLowerCase(), ctx.organizationId);
    if (!state) return { status: 404, body: { error: "project not found in this organization (no structure_state)" } };
    if (!state.checkout_user_id) return { status: 200, body: { op: "noop", structure_state: stateView(state) } };
    if (state.checkout_user_id !== ctx.actorId && !ctx.isAdmin) {
      return { status: 403, body: { error: "only the checkout holder (or an admin) may release", holder: state.checkout_user_id } };
    }
    const rows = await tx<StructureStateRow[]>`
      update places.structure_state
         set checkout_user_id = null, checkout_device_id = null, checkout_at = null, checkout_expires_at = null
       where project_id = ${state.project_id} and organization_id = ${ctx.organizationId} returning *`;
    await emitEvent(tx, ctx, {
      projectId: state.project_id, refTable: "places.structure_state", refId: state.project_id, type: "checkout.released",
      payload: { released_holder: state.checkout_user_id, by: ctx.actorId, was_live: isLive(state) },
      key: `places.structure_state:${state.project_id}:checkout.released:${Date.now()}`,
    });
    return { status: 200, body: { op: "released", structure_state: stateView(rows[0]) } };
  });
}

/** ADMIN ONLY. The admin takes the lease (a designer's structure pushes then reject no_checkout). */
export async function overrideCheckout(ctx: OrganizationContext, projectId: string, body: CheckoutBody): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!ctx.isAdmin) return { status: 403, body: { error: "checkout override is an admin act" } };
  const deviceId = typeof body.device_id === "string" && body.device_id.trim() ? body.device_id.trim() : null;
  return withOrg(ctx, async (tx) => {
    const state = await lockStructureState(tx, projectId.toLowerCase(), ctx.organizationId);
    if (!state) return { status: 404, body: { error: "project not found in this organization (no structure_state)" } };
    const settings = await readLeaseSettings(tx, ctx.organizationId);
    const now = Date.now();
    const expires = new Date(now + settings.leaseMs);
    const rows = await tx<StructureStateRow[]>`
      update places.structure_state
         set checkout_user_id = ${ctx.actorId}, checkout_device_id = ${deviceId},
             checkout_at = ${new Date(now)}, checkout_expires_at = ${expires},
             checkout_override_by = ${ctx.actorId}, checkout_override_at = ${new Date(now)}
       where project_id = ${state.project_id} and organization_id = ${ctx.organizationId} returning *`;
    await emitEvent(tx, ctx, {
      projectId: state.project_id, refTable: "places.structure_state", refId: state.project_id, type: "checkout.overridden",
      payload: {
        override_by: ctx.actorId, previous_holder: state.checkout_user_id, previous_expires_at: state.checkout_expires_at,
        previous_was_live: isLive(state, now), checkout_expires_at: expires.toISOString(),
      },
      key: `places.structure_state:${state.project_id}:checkout.overridden:${now}`,
      deviceId,
    });
    return { status: 200, body: { op: "overridden", previous_holder: state.checkout_user_id, structure_state: stateView(rows[0], settings) } };
  });
}

//------------------------------------------------------------------------------
// Cron: lease-expiry warning (walk spec §5.6 "lease expiry / warning", §6 check 7)
//------------------------------------------------------------------------------

export interface LeaseSweepResult {
  organization_id: string;
  live: number;
  warned: string[]; // project ids that received a NEW checkout.expiring event this run
}

/** One `checkout.expiring` per (project, expires_at) when now ∈ [expires_at − warn, expires_at). */
export async function sweepLeaseWarnings(ctx: OrganizationContext, now = new Date()): Promise<LeaseSweepResult> {
  return withOrg(ctx, async (tx) => {
    const settings = await readLeaseSettings(tx, ctx.organizationId);
    const rows = await tx<StructureStateRow[]>`
      select * from places.structure_state
       where organization_id = ${ctx.organizationId} and checkout_user_id is not null and checkout_expires_at > ${now}`;
    const warned: string[] = [];
    for (const s of rows) {
      const exp = s.checkout_expires_at!.getTime();
      if (exp - now.getTime() > settings.warnMs) continue;
      const fresh = await emitEvent(tx, ctx, {
        projectId: s.project_id, refTable: "places.structure_state", refId: s.project_id, type: "checkout.expiring",
        payload: { recipient: s.checkout_user_id, holder: s.checkout_user_id, checkout_expires_at: s.checkout_expires_at, warn_ms: settings.warnMs, device_id: s.checkout_device_id },
        key: `places.structure_state:${s.project_id}:checkout.expiring:${exp}`,
        deviceId: s.checkout_device_id,
      });
      if (fresh) warned.push(s.project_id);
    }
    return { organization_id: ctx.organizationId, live: rows.length, warned };
  });
}
