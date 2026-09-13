//==============================================================================
// repo/_shared.ts — helpers every repo module uses (F3).
//
//   tenantOf(env)          the tenant a repo call runs for (env.TENANT_ID; index.ts
//                          overwrites it per request from resolveTenant()).
//   ensureVocab(tx, …)     Craig's rule: writers auto-create a missing status_vocab
//                          pick-list row instead of failing the vocab trigger.
//   ensureProjectRef /     "Shadow" rows. Until P3a imports projects / work orders /
//   ensureWorkOrderRef /   action items from Zoho, the FK-bearing tables written in
//   ensureActionItemRef    this row (hours_entries, daily_reports, reminders) need
//                          a parent row. The shadow row carries the Zoho id in
//                          external_ids (the ONLY place a foreign id lives) and the
//                          few columns we know; it is marked custom._shadow = "f3" so
//                          the P3a importer upserts the real record onto it by
//                          external id instead of creating a duplicate.
//
// Every query filters tenant_id = app_tenant_id() as well as relying on RLS
// (F2 decision 2).
//==============================================================================

import { DbError, isUuid, type Tx } from "../db";
import { ZOHO_SYSTEMS } from "../backend";
import { parseWoNumber } from "../wonumber";
import { validateCustom, type FieldError } from "../field-definitions";

export { tenantOf } from "../tenant";

/** Actor recorded on events written by the API (there is no per-request identity yet — P5). */
export const API_ACTOR = "system:api";

/** ISO string for a timestamptz the driver returned as Date (or already a string). */
export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Parse a text[] the driver hands back as a Postgres array literal ("{a,b}") —
 * db.ts runs with fetch_types:false (Hyperdrive), so arrays are not decoded.
 * Already-decoded arrays pass through; NULL → [].
 */
export function pgTextArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  const s = String(v).trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return s ? [s] : [];
  const body = s.slice(1, -1);
  if (!body) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === "\\") { cur += body[++i] ?? ""; continue; }
      if (c === '"') { quoted = false; continue; }
      cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((x) => (x === "NULL" ? "" : x)).filter((x) => x !== "");
}

//------------------------------------------------------------------------------
// status_vocab
//------------------------------------------------------------------------------

/** Make sure (domain, code) exists for the tenant; returns true when it was created. */
export async function ensureVocab(tx: Tx, domain: string, code: string, label = code): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    insert into public.status_vocab (tenant_id, domain, code, label, sort_order)
    values (public.app_tenant_id(), ${domain}, ${code}, ${label},
      coalesce((select max(sort_order) + 10 from public.status_vocab
                where tenant_id = public.app_tenant_id() and domain = ${domain}), 10))
    on conflict (tenant_id, domain, code) do nothing
    returning id`;
  return rows.length === 1;
}

/** The default code of a vocab domain (is_default, else lowest sort_order), or null when the domain is empty. */
export async function defaultVocabCode(tx: Tx, domain: string): Promise<string | null> {
  const rows = await tx<{ code: string }[]>`
    select code from public.status_vocab
    where tenant_id = public.app_tenant_id() and domain = ${domain}
    order by is_default desc, sort_order asc, code asc
    limit 1`;
  return rows.length ? rows[0].code : null;
}

//------------------------------------------------------------------------------
// external_ids
//------------------------------------------------------------------------------

export async function findByExternalId(tx: Tx, entity: string, system: string, externalId: string): Promise<string | null> {
  const rows = await tx<{ entity_id: string }[]>`
    select entity_id from public.external_ids
    where tenant_id = public.app_tenant_id() and entity = ${entity} and system = ${system} and external_id = ${externalId}
    limit 1`;
  return rows.length ? rows[0].entity_id : null;
}

export async function linkExternalId(tx: Tx, entity: string, entityId: string, system: string, externalId: string): Promise<void> {
  await tx`
    insert into public.external_ids (tenant_id, entity, entity_id, system, external_id, synced_at)
    values (public.app_tenant_id(), ${entity}, ${entityId}, ${system}, ${externalId}, now())
    on conflict (tenant_id, system, external_id) do nothing`;
}

//------------------------------------------------------------------------------
// Shadow rows (projects / work_orders / action_items) — see the header.
//------------------------------------------------------------------------------

/** What the Zoho-era caller knows about a WO when it writes hours / daily-report rows. */
export interface WoRef {
  /** Zoho Action task id — the wire `WorkOrder.id`. */
  actionTaskId: string;
  /** Zoho project id (`WorkOrder.projectId`). "" when unknown. */
  zohoProjectId: string;
  /** e.g. FHI-672. "" when unknown. */
  projectKey: string;
  projectName: string;
  client?: string | null;
  /** e.g. FHI-672-WO-2026-0001. "" when unnumbered. */
  workOrderNumber: string;
  subject: string;
}

const SHADOW = { _shadow: "f3" };

/** projects.id for a Zoho project, creating a shadow row on first sight. */
export async function ensureProjectRef(
  tx: Tx,
  ref: { zohoProjectId: string; projectKey?: string; projectName?: string; client?: string | null }
): Promise<string> {
  const system = ZOHO_SYSTEMS.project;
  const zid = String(ref.zohoProjectId || "").trim();
  if (!zid) throw new DbError("ensureProjectRef: zohoProjectId is required");
  const found = await findByExternalId(tx, "project", system, zid);
  if (found) return found;

  const key = (ref.projectKey ?? "").trim() || `ZOHO-P-${zid}`;
  const name = (ref.projectName ?? "").trim() || key;
  // Reuse a real row that already carries this key (e.g. imported earlier by key) rather than a duplicate.
  const byKey = await tx<{ id: string }[]>`
    select id from public.projects
    where tenant_id = public.app_tenant_id() and public_key = ${key} and deleted_at is null
    limit 1`;
  let id: string;
  if (byKey.length) {
    id = byKey[0].id;
  } else {
    const ins = await tx<{ id: string }[]>`
      insert into public.projects (tenant_id, public_key, name, client_name, is_service, custom)
      values (public.app_tenant_id(), ${key}, ${name}, ${ref.client ?? null}, true, ${tx.json(SHADOW)})
      returning id`;
    id = ins[0].id;
  }
  await linkExternalId(tx, "project", id, system, zid);
  return id;
}

/** Key of the single placeholder project that parents shadow WOs whose Zoho project is unknown (importer only). */
export const UNMAPPED_PROJECT_KEY = "F3-UNMAPPED";

async function ensureUnmappedProject(tx: Tx): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    select id from public.projects
    where tenant_id = public.app_tenant_id() and public_key = ${UNMAPPED_PROJECT_KEY} and deleted_at is null
    limit 1`;
  if (rows.length) return rows[0].id;
  const ins = await tx<{ id: string }[]>`
    insert into public.projects (tenant_id, public_key, name, is_service, custom)
    values (public.app_tenant_id(), ${UNMAPPED_PROJECT_KEY}, 'Unmapped work orders (F3 KV import)', true, ${tx.json(SHADOW)})
    returning id`;
  return ins[0].id;
}

/**
 * work_orders.id for a wire WorkOrder.id, or null when no row exists yet.
 * P2: the id is EITHER our own uuid (Postgres-backed tenants — the row is looked
 * up directly) OR a Zoho Action task id (external_ids), so hours / daily-report
 * writes work on both paths with the same call.
 */
export async function findWorkOrderRef(tx: Tx, actionTaskId: string): Promise<string | null> {
  const id = String(actionTaskId || "").trim();
  if (!id) return null;
  if (isUuid(id)) {
    const rows = await tx<{ id: string }[]>`
      select id from public.work_orders
      where tenant_id = public.app_tenant_id() and id = ${id} and deleted_at is null
      limit 1`;
    if (rows.length) return rows[0].id;
  }
  return findByExternalId(tx, "work_order", ZOHO_SYSTEMS.work_order, id);
}

/** work_orders.id for a Zoho-era WO, creating the shadow project + WO rows on first sight. */
export async function ensureWorkOrderRef(tx: Tx, ref: WoRef): Promise<string> {
  const system = ZOHO_SYSTEMS.work_order;
  const tid = String(ref.actionTaskId || "").trim();
  if (!tid) throw new DbError("ensureWorkOrderRef: actionTaskId is required");
  const found = await findWorkOrderRef(tx, tid);
  if (found) return found;

  const projectId = ref.zohoProjectId
    ? await ensureProjectRef(tx, {
        zohoProjectId: ref.zohoProjectId,
        projectKey: ref.projectKey,
        projectName: ref.projectName,
        client: ref.client ?? null,
      })
    : await ensureUnmappedProject(tx);

  const number = (ref.workOrderNumber ?? "").trim();
  const parsed = number ? parseWoNumber(number) : null;
  const publicKey = number || `ZOHO-T-${tid}`;
  // wo_year/wo_seq are NOT NULL (wo_seq > 0). An unnumbered Zoho task (anomaly) gets 0 / 1
  // under the placeholder key; P3a replaces both when it imports the real record.
  const year = parsed ? parsed.year : 0;
  const seq = parsed ? parsed.seq : 1;
  const subject = (ref.subject ?? "").trim() || "(untitled)";

  const byKey = await tx<{ id: string }[]>`
    select id from public.work_orders
    where tenant_id = public.app_tenant_id() and public_key = ${publicKey} and deleted_at is null
    limit 1`;
  let id: string;
  if (byKey.length) {
    id = byKey[0].id;
  } else {
    const ins = await tx<{ id: string }[]>`
      insert into public.work_orders (tenant_id, public_key, project_id, wo_year, wo_seq, subject, custom)
      values (public.app_tenant_id(), ${publicKey}, ${projectId}, ${year}, ${seq}, ${subject}, ${tx.json(SHADOW)})
      returning id`;
    id = ins[0].id;
  }
  await linkExternalId(tx, "work_order", id, system, tid);
  return id;
}

/** The wire WO number (work_orders.public_key) for a row id — used for PDF filenames. */
export async function workOrderPublicKey(tx: Tx, workOrderId: string): Promise<string | null> {
  const rows = await tx<{ public_key: string }[]>`
    select public_key from public.work_orders
    where tenant_id = public.app_tenant_id() and id = ${workOrderId}
    limit 1`;
  if (!rows.length) return null;
  const k = rows[0].public_key;
  return k.startsWith("ZOHO-T-") ? null : k;
}

/** action_items.id for a Zoho issue id, creating a shadow row (project_id NULL, default status) on first sight. */
export async function ensureActionItemRef(tx: Tx, ref: { issueId: string; title?: string | null }): Promise<string> {
  const system = ZOHO_SYSTEMS.action_item;
  const iid = String(ref.issueId || "").trim();
  if (!iid) throw new DbError("ensureActionItemRef: issueId is required");
  const found = await findByExternalId(tx, "action_item", system, iid);
  if (found) return found;

  let status = await defaultVocabCode(tx, "action_item_status");
  if (!status) {
    await ensureVocab(tx, "action_item_status", "Open");
    status = "Open";
  }
  const ins = await tx<{ id: string }[]>`
    insert into public.action_items (tenant_id, title, status, custom)
    values (public.app_tenant_id(), ${(ref.title ?? "").trim() || "Action item"}, ${status}, ${tx.json(SHADOW)})
    returning id`;
  await linkExternalId(tx, "action_item", ins[0].id, system, iid);
  return ins[0].id;
}

export async function findActionItemRef(tx: Tx, issueId: string): Promise<string | null> {
  return findByExternalId(tx, "action_item", ZOHO_SYSTEMS.action_item, String(issueId || "").trim());
}

//------------------------------------------------------------------------------
// Custom fields (P2, data-model §8.11) — every write that carries `custom`
// validates it against field_definitions before persisting.
//------------------------------------------------------------------------------

/** Thrown when a `custom` payload fails field_definitions validation (router → 400). */
export class CustomFieldError extends Error {
  constructor(public readonly errors: FieldError[]) {
    super(`invalid custom fields: ${errors.map((e) => `${e.key}: ${e.message}`).join("; ")}`);
    this.name = "CustomFieldError";
  }
}

/** True when `v` looks like a custom payload (a plain object). */
export function isCustomObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merge a patch onto the stored custom object (shallow; null deletes a key) and
 * validate the RESULT against the entity's field_definitions. Keys starting with
 * "_" are system markers (e.g. `_shadow`) and are carried through unvalidated.
 * Returns the object to store.
 */
export async function mergeAndValidateCustom(
  tx: Tx,
  entity: string,
  existing: Record<string, unknown> | null | undefined,
  patch: unknown
): Promise<Record<string, unknown>> {
  if (patch !== undefined && !isCustomObject(patch)) {
    throw new CustomFieldError([{ key: "custom", code: "type", message: "custom must be an object" }]);
  }
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const toValidate: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) if (!k.startsWith("_")) toValidate[k] = v;
  const r = await validateCustom(tx, entity, toValidate);
  if (!r.ok) throw new CustomFieldError(r.errors);
  return merged;
}

/** The wire `custom` value: always an object, system "_" keys hidden. */
export function customOut(v: unknown): Record<string, unknown> {
  if (!isCustomObject(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (!k.startsWith("_")) out[k] = val;
  return out;
}
