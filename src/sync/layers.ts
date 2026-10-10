// row: W3 · run: run-2026-10-07-drawing-layer-05 · 2026-10-07
// row: W5c · run: run-2026-10-07-drawing-layer-11 · 2026-10-09 — layerView exported for the GET /drawings/:id bundle (drawings-list.ts)
//==============================================================================
// sync/layers.ts — layer governance (drawing-layer spec §2a Amendment 1, §5.3, §5.5).
//
// Three things live here, all in TypeScript (none in PL/pgSQL):
//
// 1. The per-table rule hooks plugged into TABLE_SPECS (W1's seam):
//    drawings.annotations — R-layer-write + R-class-stamp
//      INSERT: resolve the requested layer (must belong to the page's drawing, else
//              unknown_parent). Writable = not locked AND write_policy satisfied AND (for a
//              structure layer under a Project) the actor holds the LIVE checkout. Not
//              writable → REDIRECT to the actor's role-default layer for that drawing
//              (template default_for_role = role → first writable capture/any_member layer by
//              ordinal → whiteboards: Board). redirected_from_layer_id = the requested layer.
//              class is COPIED from the layer the row finally lands on. Stamped once.
//      UPDATE: an incoming class ≠ stored class → 'immutable_class' (the ONE new refusal — a
//              client-bug signal). A changed layer_id: same class → plain move (R-move); the
//              target is not writable → the row STAYS on its current layer (redirect = no-op
//              move, reported); a different class → 'immutable_class' (promotion onto a
//              structure layer MINTS A NEW ROW — row W4's PATCH /annotations/:id, not here).
//              The device re-sending the layer it originally asked for (== stored
//              redirected_from_layer_id) is a sticky redirect, not a move.
//              A lock never touches existing rows (R-lock: future writes only).
//    drawings.layers — device-minted template layers are validated against the template
//      (same org, same drawing kind, name/ordinal/class/write_policy/export equal, template not
//      already instantiated on that drawing) → else 'schema'. class / write_policy are
//      immutable on an existing layer ('schema').
//    There is NO layer-based rejection reason anywhere: a layer condition redirects.
//
// 2. Template instantiation: ensureTemplateLayers(tx, ctx, drawingId) mints, server-side, every
//    layer_template of the Organization for the drawing's kind that the drawing does not yet
//    carry (template_id match). pushBatch calls it for every drawing CREATED in the batch, in the
//    same transaction, and returns the minted rows as `created_layers`. A drawing never exists
//    without its template layers (when the Organization has templates for that kind).
//
// 3. Layer CRUD (office/admin; designers may add / rename / reorder, never lock):
//      POST   /drawings/:id/layers              {name, class, write_policy, export?, ordinal?, color_hint?}
//      PATCH  /drawings/:id/layers/:layerId     {name?, ordinal?, export?, color_hint?, locked?}
//      DELETE /drawings/:id/layers/:layerId     tombstone (deleted_at); 409 while non-deleted annotations reference it
//    `locked` is a BOOLEAN set by a person (locked_by / locked_at are audit, not a holder): no
//    expiry, no lease, no cron. Events layer.created / layer.updated / layer.locked /
//    layer.unlocked / layer.tombstoned. class and write_policy are immutable after creation (400).
//    Layers are shared — never per-user.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { readStructureState, isLive, emitEvent, type RouteResult } from "./checkout";
import { setTableRuleHook, type JsonRow, type RuleHookInput, type RuleHookResult, type RowClass } from "./tables";

//------------------------------------------------------------------------------
// Types
//------------------------------------------------------------------------------

export type WritePolicy = "designer_checkout" | "designer" | "any_member" | "admin";
export type RedirectReason = "locked" | "policy";

export interface LayerRow {
  id: string;
  organization_id: string;
  drawing_id: string;
  template_id: string | null;
  name: string;
  ordinal: number;
  class: RowClass;
  write_policy: WritePolicy;
  locked: boolean;
  locked_by: string | null;
  locked_at: Date | null;
  export: boolean;
  color_hint: string | null;
  revision: number;
  deleted_at: Date | null;
  /** From the joined template (NULL for custom layers). */
  default_for_role: string | null;
}

interface Actor {
  actorId: string;
  role: string;
  isAdmin: boolean;
}

const LAYER_SELECT = (tx: Tx) => tx`
  select l.id, l.organization_id, l.drawing_id, l.template_id, l.name, l.ordinal, l.class, l.write_policy,
         l.locked, l.locked_by, l.locked_at, l.export, l.color_hint, l.revision, l.deleted_at,
         t.default_for_role
    from drawings.layers l
    left join drawings.layer_templates t on t.id = l.template_id and t.organization_id = l.organization_id`;

export async function readLayer(tx: Tx, layerId: string, org: string): Promise<LayerRow | null> {
  const rows = await tx<LayerRow[]>`${LAYER_SELECT(tx)} where l.id = ${layerId} and l.organization_id = ${org} limit 1`;
  return rows[0] ?? null;
}

export async function readDrawingLayers(tx: Tx, drawingId: string, org: string): Promise<LayerRow[]> {
  return tx<LayerRow[]>`${LAYER_SELECT(tx)} where l.drawing_id = ${drawingId} and l.organization_id = ${org} and l.deleted_at is null order by l.ordinal, l.created_at, l.id`;
}

//------------------------------------------------------------------------------
// Writability (R-layer-write)
//------------------------------------------------------------------------------

/** Does the actor's ROLE satisfy the policy? designer_checkout under a Project also needs the live checkout (see isWritable). */
export function policySatisfied(policy: WritePolicy, actor: Actor, holdsCheckout: boolean, hasProject: boolean): boolean {
  const designer = actor.isAdmin || actor.role === "designer" || actor.role === "admin";
  switch (policy) {
    case "any_member": return true;
    case "admin": return actor.isAdmin || actor.role === "admin";
    case "designer": return designer;
    case "designer_checkout":
      // Unattached drawing: nothing to hold → behaves as 'designer' (spec §5.3).
      return hasProject ? holdsCheckout : designer;
  }
}

export interface Writability {
  writable: boolean;
  reason?: RedirectReason;
}

/**
 * Not locked, not tombstoned, policy met — and a STRUCTURE layer under a Project is reachable only
 * through the live checkout whatever its write_policy says (the checkout is the only gate to structure).
 */
export function isWritable(layer: LayerRow, actor: Actor, holdsCheckout: boolean, hasProject: boolean): Writability {
  if (layer.deleted_at != null) return { writable: false, reason: "locked" };
  if (layer.locked) return { writable: false, reason: "locked" };
  if (!policySatisfied(layer.write_policy, actor, holdsCheckout, hasProject)) return { writable: false, reason: "policy" };
  if (layer.class === "structure" && hasProject && !holdsCheckout) return { writable: false, reason: "policy" };
  return { writable: true };
}

/** The actor's role as a default_for_role key; admins look for 'admin' first, then their member role. */
function roleKeys(actor: Actor): string[] {
  const keys: string[] = [];
  if (actor.isAdmin) keys.push("admin");
  if (actor.role && !keys.includes(actor.role)) keys.push(actor.role);
  return keys;
}

/**
 * The layer a redirected row lands on: the role-default template layer if writable, else the first
 * writable capture / any_member layer by ordinal, else the first writable layer at all. When NOTHING
 * on the drawing is writable the ink is still never stranded: it lands on the role default (or the
 * first capture layer) and the redirect is reported — flagged in the W3 report as a judgment item.
 */
export function pickLandingLayer(layers: LayerRow[], actor: Actor, holdsCheckout: boolean, hasProject: boolean): LayerRow | null {
  const live = layers.filter((l) => l.deleted_at == null);
  if (live.length === 0) return null;
  const byOrdinal = [...live].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const ordered: LayerRow[] = [];
  for (const key of roleKeys(actor)) for (const l of byOrdinal) if (l.default_for_role === key && !ordered.includes(l)) ordered.push(l);
  for (const l of byOrdinal) if (l.class === "capture" && l.write_policy === "any_member" && !ordered.includes(l)) ordered.push(l);
  for (const l of byOrdinal) if (l.class === "capture" && !ordered.includes(l)) ordered.push(l);
  for (const l of byOrdinal) if (!ordered.includes(l)) ordered.push(l);
  const writable = ordered.find((l) => isWritable(l, actor, holdsCheckout, hasProject).writable);
  if (writable) return writable;
  return ordered.find((l) => l.class === "capture") ?? ordered[0];
}

export async function holdsLiveCheckout(tx: Tx, projectId: string | null, org: string, actorId: string): Promise<boolean> {
  if (!projectId) return false;
  const state = await readStructureState(tx, projectId, org);
  return !!state && isLive(state) && state.checkout_user_id === actorId;
}

//------------------------------------------------------------------------------
// Hook: drawings.annotations
//------------------------------------------------------------------------------

async function drawingOfPage(tx: Tx, pageId: string, org: string): Promise<{ drawing_id: string; project_id: string | null; kind: string } | null> {
  const rows = await tx<{ drawing_id: string; project_id: string | null; kind: string }[]>`
    select p.drawing_id, d.project_id, d.kind from drawings.pages p join drawings.drawings d on d.id = p.drawing_id
     where p.id = ${pageId} and p.organization_id = ${org} and d.organization_id = ${org}`;
  return rows[0] ?? null;
}

export const annotationRuleHook = async (input: RuleHookInput): Promise<RuleHookResult> => {
  const { tx, row, existing, actorId, role, isAdmin } = input;
  const actor: Actor = { actorId, role, isAdmin };
  const org = row.organization_id as string;
  const pageId = ((existing?.page_id as string | undefined) ?? (row.page_id as string | undefined))?.toLowerCase();
  if (!pageId) return { kind: "reject", reason: "schema", detail: "page_id is required" };
  const page = await drawingOfPage(tx, pageId, org);
  if (!page) return { kind: "reject", reason: "unknown_parent", detail: "page_id → drawings.pages not found in this organization" };
  const hasProject = page.project_id != null;
  const holds = await holdsLiveCheckout(tx, page.project_id, org, actorId);

  // ---- UPDATE / tombstone: class is immutable; a move is same-class only ---------------------
  if (existing) {
    const storedClass = existing.class as RowClass;
    const storedLayer = (existing.layer_id as string).toLowerCase();
    if (row.class != null && row.class !== storedClass) {
      return { kind: "reject", reason: "immutable_class", detail: `class is stamped once (stored '${storedClass}', pushed '${String(row.class)}')` };
    }
    const out: JsonRow = { ...row, class: storedClass };
    const requested = isUuid(row.layer_id) ? (row.layer_id as string).toLowerCase() : null;
    const stickyRedirect = requested != null && requested === ((existing.redirected_from_layer_id as string | null) ?? null)?.toLowerCase();
    if (requested == null || requested === storedLayer) {
      out.layer_id = storedLayer; // no move (a lock never affects existing rows — R-lock)
      return { kind: "ok", row: out, rowClass: storedClass, drawingId: page.drawing_id };
    }
    if (stickyRedirect) {
      // The device still names the layer it first asked for (it may never have seen the first answer —
      // an idempotent replay). Not a move: restate the redirect so the device can show it once.
      out.layer_id = storedLayer;
      const asked = await readLayer(tx, requested, org);
      const w = asked ? isWritable(asked, actor, holds, hasProject) : { writable: false, reason: "locked" as const };
      return { kind: "ok", row: out, rowClass: storedClass, redirected: true, redirectedTo: storedLayer, redirectReason: w.writable ? "policy" : w.reason, drawingId: page.drawing_id };
    }
    // a move
    const target = await readLayer(tx, requested, org);
    if (!target || target.drawing_id !== page.drawing_id) {
      return { kind: "reject", reason: "unknown_parent", detail: "layer_id is not a layer of this page's drawing" };
    }
    if (target.class !== storedClass) {
      return {
        kind: "reject", reason: "immutable_class",
        detail: target.class === "structure"
          ? "moving onto a structure layer is a promotion: it mints a new row (PATCH /annotations/:id, row W4), never a re-stamp"
          : "moving a structure row onto a capture layer would change its class; class is stamped once",
      };
    }
    const w = isWritable(target, actor, holds, hasProject);
    if (!w.writable) {
      // Redirect on a move = the row stays where it is; the device is told once.
      out.layer_id = storedLayer;
      return { kind: "ok", row: out, rowClass: storedClass, redirected: true, redirectedTo: storedLayer, redirectReason: w.reason, drawingId: page.drawing_id };
    }
    out.layer_id = target.id;
    return { kind: "ok", row: out, rowClass: storedClass, drawingId: page.drawing_id };
  }

  // ---- INSERT: resolve, evaluate, redirect, stamp -------------------------------------------
  const requested = isUuid(row.layer_id) ? (row.layer_id as string).toLowerCase() : null;
  if (!requested) return { kind: "reject", reason: "schema", detail: "layer_id is required" };
  const target = await readLayer(tx, requested, org);
  if (!target || target.drawing_id !== page.drawing_id) {
    return { kind: "reject", reason: "unknown_parent", detail: "layer_id is not a layer of this page's drawing" };
  }
  const w = isWritable(target, actor, holds, hasProject);
  if (w.writable) {
    return { kind: "ok", row: { ...row, layer_id: target.id, class: target.class }, rowClass: target.class, drawingId: page.drawing_id };
  }
  const layers = await readDrawingLayers(tx, page.drawing_id, org);
  const landing = pickLandingLayer(layers.filter((l) => l.id !== target.id), actor, holds, hasProject) ?? pickLandingLayer(layers, actor, holds, hasProject);
  if (!landing) return { kind: "reject", reason: "unknown_parent", detail: "drawing has no layers to land on" };
  const extra: JsonRow = { redirected_from_layer_id: target.id };
  return {
    kind: "ok",
    row: { ...row, layer_id: landing.id, class: landing.class },
    extra,
    rowClass: landing.class,
    redirected: true,
    redirectedTo: landing.id,
    redirectReason: w.reason,
    drawingId: page.drawing_id,
  };
};

//------------------------------------------------------------------------------
// Hook: drawings.layers (device-minted template layers)
//------------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  key: string;
  name: string;
  ordinal: number;
  class: RowClass;
  write_policy: WritePolicy;
  default_for_role: string | null;
  export: boolean;
  color_hint: string | null;
  drawing_kind: string;
}

export const layerRuleHook = async (input: RuleHookInput): Promise<RuleHookResult> => {
  const { tx, row, existing } = input;
  const org = row.organization_id as string;
  if (existing) {
    if (row.class != null && row.class !== existing.class) return { kind: "reject", reason: "schema", detail: "layers.class is immutable after creation" };
    if (row.write_policy != null && row.write_policy !== existing.write_policy) return { kind: "reject", reason: "schema", detail: "layers.write_policy is immutable after creation" };
    if (row.template_id != null && row.template_id !== existing.template_id) return { kind: "reject", reason: "schema", detail: "layers.template_id is immutable after creation" };
    return { kind: "ok", row: { ...row, class: existing.class, write_policy: existing.write_policy, template_id: existing.template_id }, rowClass: "structure" };
  }
  const templateId = isUuid(row.template_id) ? (row.template_id as string).toLowerCase() : null;
  if (!templateId) {
    if (row.class == null || row.write_policy == null || row.name == null) return { kind: "reject", reason: "schema", detail: "a custom layer needs name, class and write_policy" };
    return { kind: "ok", row, rowClass: "structure" };
  }
  const drawingId = (row.drawing_id as string).toLowerCase();
  const d = await tx<{ kind: string }[]>`select kind from drawings.drawings where id = ${drawingId} and organization_id = ${org}`;
  const tpl = await tx<TemplateRow[]>`
    select id, key, name, ordinal, class, write_policy, default_for_role, export, color_hint, drawing_kind
      from drawings.layer_templates where id = ${templateId} and organization_id = ${org} and deleted_at is null`;
  if (!d[0] || !tpl[0]) return { kind: "reject", reason: "unknown_parent", detail: "template_id → drawings.layer_templates not found in this organization" };
  const t = tpl[0];
  if (t.drawing_kind !== d[0].kind) return { kind: "reject", reason: "schema", detail: `template_mismatch: template is for ${t.drawing_kind} drawings, drawing is ${d[0].kind}` };
  const mismatches: string[] = [];
  if (row.name != null && row.name !== t.name) mismatches.push("name");
  if (row.ordinal != null && Number(row.ordinal) !== t.ordinal) mismatches.push("ordinal");
  if (row.class != null && row.class !== t.class) mismatches.push("class");
  if (row.write_policy != null && row.write_policy !== t.write_policy) mismatches.push("write_policy");
  if (row.export != null && Boolean(row.export) !== t.export) mismatches.push("export");
  if (mismatches.length) return { kind: "reject", reason: "schema", detail: `template_mismatch: ${mismatches.join(", ")} differ from the template` };
  const dup = await tx<{ id: string }[]>`
    select id from drawings.layers where drawing_id = ${drawingId} and organization_id = ${org} and template_id = ${templateId} and id <> ${row.id as string} limit 1`;
  if (dup[0]) return { kind: "reject", reason: "schema", detail: `template_mismatch: template already instantiated on this drawing as layer ${dup[0].id}` };
  // Fill what the device left out from the template so the row IS the template's layer.
  const filled: JsonRow = {
    ...row,
    name: row.name ?? t.name,
    ordinal: row.ordinal ?? t.ordinal,
    class: t.class,
    write_policy: t.write_policy,
    export: row.export ?? t.export,
    color_hint: row.color_hint ?? t.color_hint,
  };
  return { kind: "ok", row: filled, rowClass: "structure" };
};

/** Register both hooks (idempotent; push.ts imports this module for its side effect). */
export function registerLayerHooks(): void {
  setTableRuleHook("drawings.annotations", annotationRuleHook);
  setTableRuleHook("drawings.layers", layerRuleHook);
}
registerLayerHooks();

//------------------------------------------------------------------------------
// Template instantiation (server-minted layers)
//------------------------------------------------------------------------------

export interface CreatedLayer {
  drawing_id: string;
  id: string;
  template_id: string;
  name: string;
  ordinal: number;
  class: RowClass;
  write_policy: WritePolicy;
  export: boolean;
  locked: boolean;
}

/** Mint every template layer the drawing lacks. Same transaction as the caller. Returns the rows minted now. */
export async function ensureTemplateLayers(tx: Tx, ctx: OrganizationContext, drawingId: string, deviceId: string | null = null): Promise<CreatedLayer[]> {
  const org = ctx.organizationId;
  const d = await tx<{ kind: string; project_id: string | null; occurred_at: Date }[]>`
    select kind, project_id, occurred_at from drawings.drawings where id = ${drawingId} and organization_id = ${org}`;
  if (!d[0]) return [];
  const missing = await tx<TemplateRow[]>`
    select t.id, t.key, t.name, t.ordinal, t.class, t.write_policy, t.default_for_role, t.export, t.color_hint, t.drawing_kind
      from drawings.layer_templates t
     where t.organization_id = ${org} and t.drawing_kind = ${d[0].kind} and t.deleted_at is null
       and not exists (select 1 from drawings.layers l where l.drawing_id = ${drawingId} and l.organization_id = ${org} and l.template_id = t.id)
     order by t.ordinal, t.key`;
  const out: CreatedLayer[] = [];
  for (const t of missing) {
    const rows = await tx<{ id: string }[]>`
      insert into drawings.layers (organization_id, drawing_id, template_id, name, ordinal, class, write_policy, export, color_hint, occurred_at, device_id, created_by)
      values (${org}, ${drawingId}, ${t.id}, ${t.name}, ${t.ordinal}, ${t.class}, ${t.write_policy}, ${t.export}, ${t.color_hint}, ${d[0].occurred_at}, ${deviceId}, ${ctx.actorId})
      returning id`;
    const id = rows[0].id;
    await emitEvent(tx, ctx, {
      projectId: d[0].project_id, refTable: "drawings.layers", refId: id, type: "layer.created",
      payload: { op: "created", class: "structure", revision: 1, template_id: t.id, template_key: t.key, drawing_id: drawingId, server_minted: true },
      key: `drawings.layers:${id}:1`, deviceId,
    });
    out.push({ drawing_id: drawingId, id, template_id: t.id, name: t.name, ordinal: t.ordinal, class: t.class, write_policy: t.write_policy, export: t.export, locked: false });
  }
  return out;
}

//------------------------------------------------------------------------------
// Layer CRUD routes
//------------------------------------------------------------------------------

const CLASSES = new Set(["structure", "capture"]);
const POLICIES = new Set(["designer_checkout", "designer", "any_member", "admin"]);

function isOfficeOrAdmin(ctx: OrganizationContext): boolean {
  return ctx.isAdmin || ctx.role === "office" || ctx.role === "admin";
}
function mayEditLayers(ctx: OrganizationContext): boolean {
  return isOfficeOrAdmin(ctx) || ctx.role === "designer";
}

export function layerView(l: LayerRow | JsonRow): Record<string, unknown> {
  const r = l as JsonRow;
  return {
    id: r.id, drawing_id: r.drawing_id, template_id: r.template_id ?? null, name: r.name, ordinal: r.ordinal, class: r.class,
    write_policy: r.write_policy, locked: r.locked, locked_by: r.locked_by ?? null, locked_at: r.locked_at ?? null,
    export: r.export, color_hint: r.color_hint ?? null, revision: r.revision, deleted_at: r.deleted_at ?? null,
  };
}

async function readDrawing(tx: Tx, drawingId: string, org: string): Promise<{ id: string; kind: string; project_id: string | null; deleted_at: Date | null } | null> {
  const rows = await tx<{ id: string; kind: string; project_id: string | null; deleted_at: Date | null }[]>`
    select id, kind, project_id, deleted_at from drawings.drawings where id = ${drawingId} and organization_id = ${org}`;
  return rows[0] ?? null;
}

/** GET /drawings/:id/layers — every non-deleted layer in render order (ordinal). */
export async function listLayers(ctx: OrganizationContext, drawingId: string): Promise<RouteResult> {
  if (!isUuid(drawingId)) return { status: 400, body: { error: "drawing id must be a UUID" } };
  return withOrg(ctx, async (tx) => {
    const d = await readDrawing(tx, drawingId.toLowerCase(), ctx.organizationId);
    if (!d || d.deleted_at) return { status: 404, body: { error: "drawing not found in this organization" } };
    const layers = await readDrawingLayers(tx, d.id, ctx.organizationId);
    return { status: 200, body: { drawing_id: d.id, layers: layers.map(layerView) } };
  }, { readOnly: true });
}

/** POST /drawings/:id/layers — add a custom (non-template) layer. Designer / office / admin. */
export async function createLayer(ctx: OrganizationContext, drawingId: string, body: Record<string, unknown>): Promise<RouteResult> {
  if (!isUuid(drawingId)) return { status: 400, body: { error: "drawing id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayEditLayers(ctx)) return { status: 403, body: { error: "only designer, office or admin may add layers" } };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { status: 400, body: { error: "name is required" } };
  if (!CLASSES.has(body.class as string)) return { status: 400, body: { error: "class must be 'structure' or 'capture'" } };
  if (!POLICIES.has(body.write_policy as string)) return { status: 400, body: { error: "write_policy must be designer_checkout | designer | any_member | admin" } };
  if (body.ordinal != null && !Number.isInteger(Number(body.ordinal))) return { status: 400, body: { error: "ordinal must be an integer" } };
  if (body.export != null && typeof body.export !== "boolean") return { status: 400, body: { error: "export must be a boolean" } };
  if (body.locked != null) return { status: 400, body: { error: "locked is set with PATCH after creation (office/admin)" } };
  if (body.template_id != null) return { status: 400, body: { error: "template layers are instantiated by the server, not posted" } };
  const exportFlag = body.export == null ? true : Boolean(body.export);
  const colorHint = typeof body.color_hint === "string" ? body.color_hint : null;

  return withOrg(ctx, async (tx) => {
    const d = await readDrawing(tx, drawingId.toLowerCase(), ctx.organizationId);
    if (!d || d.deleted_at) return { status: 404, body: { error: "drawing not found in this organization" } };
    let ordinal: number;
    if (body.ordinal != null) ordinal = Number(body.ordinal);
    else {
      const mx = await tx<{ m: number | null }[]>`select max(ordinal) as m from drawings.layers where drawing_id = ${d.id} and organization_id = ${ctx.organizationId} and deleted_at is null`;
      ordinal = (mx[0]?.m ?? 0) + 1;
    }
    const rows = await tx<JsonRow[]>`
      insert into drawings.layers (organization_id, drawing_id, template_id, name, ordinal, class, write_policy, export, color_hint, occurred_at, created_by)
      values (${ctx.organizationId}, ${d.id}, null, ${name}, ${ordinal}, ${body.class as string}, ${body.write_policy as string}, ${exportFlag}, ${colorHint}, now(), ${ctx.actorId})
      returning *`;
    const layer = rows[0];
    await emitEvent(tx, ctx, {
      projectId: d.project_id, refTable: "drawings.layers", refId: layer.id as string, type: "layer.created",
      payload: { op: "created", class: "structure", revision: 1, drawing_id: d.id, name, layer_class: body.class, write_policy: body.write_policy },
      key: `drawings.layers:${layer.id as string}:1`,
    });
    return { status: 201, body: { op: "created", layer: layerView(layer) } };
  });
}

/** PATCH /drawings/:id/layers/:layerId — rename / reorder (designer+), export + locked (office/admin). class/write_policy immutable (400). */
export async function patchLayer(ctx: OrganizationContext, drawingId: string, layerId: string, body: Record<string, unknown>): Promise<RouteResult> {
  if (!isUuid(drawingId) || !isUuid(layerId)) return { status: 400, body: { error: "ids must be UUIDs" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayEditLayers(ctx)) return { status: 403, body: { error: "only designer, office or admin may edit layers" } };
  if (body.class != null || body.write_policy != null || body.template_id != null) {
    return { status: 400, body: { error: "class, write_policy and template_id are immutable after creation" } };
  }
  const set: JsonRow = {};
  if (body.name != null) {
    if (typeof body.name !== "string" || !body.name.trim()) return { status: 400, body: { error: "name must be a non-empty string" } };
    set.name = body.name.trim();
  }
  if (body.ordinal != null) {
    if (!Number.isInteger(Number(body.ordinal))) return { status: 400, body: { error: "ordinal must be an integer" } };
    set.ordinal = Number(body.ordinal);
  }
  if (body.color_hint !== undefined) {
    if (body.color_hint != null && typeof body.color_hint !== "string") return { status: 400, body: { error: "color_hint must be a string or null" } };
    set.color_hint = body.color_hint ?? null;
  }
  if (body.export != null) {
    if (typeof body.export !== "boolean") return { status: 400, body: { error: "export must be a boolean" } };
    if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office or admin may change export" } };
    set.export = body.export;
  }
  let lock: boolean | null = null;
  if (body.locked != null) {
    if (typeof body.locked !== "boolean") return { status: 400, body: { error: "locked must be a boolean" } };
    if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office or admin may lock or unlock a layer" } };
    lock = body.locked;
  }
  if (Object.keys(set).length === 0 && lock == null) return { status: 400, body: { error: "nothing to change" } };

  return withOrg(ctx, async (tx) => {
    const d = await readDrawing(tx, drawingId.toLowerCase(), ctx.organizationId);
    if (!d || d.deleted_at) return { status: 404, body: { error: "drawing not found in this organization" } };
    const cur = await readLayer(tx, layerId.toLowerCase(), ctx.organizationId);
    if (!cur || cur.drawing_id !== d.id || cur.deleted_at) return { status: 404, body: { error: "layer not found on this drawing" } };

    const lockChanged = lock != null && lock !== cur.locked;
    if (lock != null && !lockChanged && Object.keys(set).length === 0) {
      return { status: 200, body: { op: "noop", layer: layerView(cur) } };
    }
    const nextRevision = cur.revision + 1;
    const rows = await tx<JsonRow[]>`
      update drawings.layers
         set name = ${(set.name as string | undefined) ?? cur.name},
             ordinal = ${(set.ordinal as number | undefined) ?? cur.ordinal},
             color_hint = ${set.color_hint !== undefined ? (set.color_hint as string | null) : cur.color_hint},
             export = ${(set.export as boolean | undefined) ?? cur.export},
             locked = ${lock ?? cur.locked},
             locked_by = ${lock == null ? cur.locked_by : lock ? ctx.actorId : null},
             locked_at = ${lock == null ? cur.locked_at : lock ? new Date() : null},
             revision = ${nextRevision},
             received_at = now()
       where id = ${cur.id} and organization_id = ${ctx.organizationId}
       returning *`;
    const layer = rows[0];
    const changed = Object.keys(set);
    if (lockChanged) {
      await emitEvent(tx, ctx, {
        projectId: d.project_id, refTable: "drawings.layers", refId: cur.id, type: lock ? "layer.locked" : "layer.unlocked",
        payload: { op: "updated", class: "structure", revision: nextRevision, drawing_id: d.id, locked: lock, name: layer.name },
        key: `drawings.layers:${cur.id}:${nextRevision}:${lock ? "locked" : "unlocked"}`,
      });
    }
    if (changed.length) {
      await emitEvent(tx, ctx, {
        projectId: d.project_id, refTable: "drawings.layers", refId: cur.id, type: "layer.updated",
        payload: { op: "updated", class: "structure", revision: nextRevision, drawing_id: d.id, changed },
        key: `drawings.layers:${cur.id}:${nextRevision}`,
      });
    }
    return { status: 200, body: { op: lockChanged ? (lock ? "locked" : "unlocked") : "updated", layer: layerView(layer) } };
  });
}

/** DELETE /drawings/:id/layers/:layerId — tombstone (office/admin). 409 while non-deleted annotations reference it. */
export async function tombstoneLayer(ctx: OrganizationContext, drawingId: string, layerId: string): Promise<RouteResult> {
  if (!isUuid(drawingId) || !isUuid(layerId)) return { status: 400, body: { error: "ids must be UUIDs" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office or admin may remove a layer" } };
  return withOrg(ctx, async (tx) => {
    const d = await readDrawing(tx, drawingId.toLowerCase(), ctx.organizationId);
    if (!d || d.deleted_at) return { status: 404, body: { error: "drawing not found in this organization" } };
    const cur = await readLayer(tx, layerId.toLowerCase(), ctx.organizationId);
    if (!cur || cur.drawing_id !== d.id) return { status: 404, body: { error: "layer not found on this drawing" } };
    if (cur.deleted_at) return { status: 200, body: { op: "noop", layer: layerView(cur) } };
    const refs = await tx<{ n: string }[]>`
      select count(*)::text as n from drawings.annotations
       where layer_id = ${cur.id} and organization_id = ${ctx.organizationId} and deleted_at is null`;
    const n = Number(refs[0].n);
    if (n > 0) return { status: 409, body: { error: "layer is referenced by annotations; move or tombstone them first", annotations: n } };
    const nextRevision = cur.revision + 1;
    const rows = await tx<JsonRow[]>`
      update drawings.layers
         set deleted_at = now(), deleted_by = ${ctx.actorId}, revision = ${nextRevision}, received_at = now()
       where id = ${cur.id} and organization_id = ${ctx.organizationId}
       returning *`;
    await emitEvent(tx, ctx, {
      projectId: d.project_id, refTable: "drawings.layers", refId: cur.id, type: "layer.tombstoned",
      payload: { op: "tombstoned", class: "structure", revision: nextRevision, drawing_id: d.id, name: cur.name },
      key: `drawings.layers:${cur.id}:${nextRevision}`,
    });
    return { status: 200, body: { op: "tombstoned", layer: layerView(rows[0]) } };
  });
}
