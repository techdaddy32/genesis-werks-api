//==============================================================================
// repo/technicians.ts — the managed Technicians registry on Postgres (F3).
//
// Replaces src/technicians.ts (KV key `technicians`). Same exported functions
// and the same wire shape (Technician = {id, name, email, active, createdAt,
// updatedAt} — key order matters: the JSON is a UI contract).
//
// Storage (0001 §3, F1 §8.6): ONE users table; a technician is a user with a
// user_roles row role = 'technician'. Reads come from v_technicians. Writes go
// to users + user_roles inside one withTenant() transaction and append an
// events row — the only side effect.
//
// Unified-model consequence (documented in F3-NOTES): the email unique index
// spans ALL users. Adding a technician whose email already belongs to a user
// without the role PROMOTES that user (adds the role, applies the given name)
// instead of creating a duplicate person.
//==============================================================================

import type { Env } from "../types";
import { withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { API_ACTOR, ensureVocab, iso, tenantOf } from "./_shared";

export const TECHNICIAN_ROLE = "technician";

export interface Technician {
  id: string;
  name: string;
  email: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AddTechnicianInput {
  name: string;
  email: string;
}

export interface UpdateTechnicianInput {
  name?: string;
  email?: string;
  active?: boolean;
}

/** Thrown for bad input (missing/invalid name or email, duplicate). Mapped to 400. */
export class TechnicianError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TechnicianError";
  }
}

//------------------------------------------------------------------------------
// Validation (unchanged from the KV module)
//------------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertValid(name: string, email: string): void {
  if (!name || !name.trim()) throw new TechnicianError("name is required");
  if (!email || !email.trim()) throw new TechnicianError("email is required");
  if (!EMAIL_RE.test(email.trim())) throw new TechnicianError(`invalid email: '${email}'`);
}

//------------------------------------------------------------------------------
// Rows → wire
//------------------------------------------------------------------------------
interface TechRow {
  id: string;
  name: string;
  email: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toTechnician(r: TechRow): Technician {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? "",
    active: !!r.active,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

const V_COLS = ["id", "name", "email", "active", "created_at", "updated_at"] as const;

//------------------------------------------------------------------------------
// Transaction-level primitives (shared with scripts/import-kv.ts)
//------------------------------------------------------------------------------

export async function listTechniciansTx(tx: Tx, opts: { activeOnly?: boolean } = {}): Promise<Technician[]> {
  const rows = await tx<TechRow[]>`
    select ${tx(V_COLS)} from public.v_technicians
    where tenant_id = public.app_tenant_id() ${opts.activeOnly ? tx`and active = true` : tx``}
    order by name asc`;
  // Stable, human-friendly ordering for the UI (same comparator as before).
  return rows.map(toTechnician).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTechnicianTx(tx: Tx, id: string): Promise<Technician | null> {
  const rows = await tx<TechRow[]>`
    select ${tx(V_COLS)} from public.v_technicians
    where tenant_id = public.app_tenant_id() and id = ${id}
    limit 1`;
  return rows.length ? toTechnician(rows[0]) : null;
}

async function userIdByEmail(tx: Tx, email: string): Promise<string | null> {
  const rows = await tx<{ id: string }[]>`
    select id from public.users
    where tenant_id = public.app_tenant_id() and deleted_at is null and lower(email) = ${email}
    limit 1`;
  return rows.length ? rows[0].id : null;
}

async function hasRole(tx: Tx, userId: string, role: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    select 1 as one from public.user_roles
    where tenant_id = public.app_tenant_id() and user_id = ${userId} and role = ${role}
    limit 1`;
  return rows.length > 0;
}

async function addRole(tx: Tx, userId: string, role: string): Promise<void> {
  await ensureVocab(tx, "user_role", role);
  await tx`
    insert into public.user_roles (tenant_id, user_id, role)
    values (public.app_tenant_id(), ${userId}, ${role})
    on conflict (tenant_id, user_id, role) do nothing`;
}

/**
 * Create (or promote) a technician. `opts.id` lets the importer keep the legacy KV id
 * so technicianIds stored by the app stay valid. Returns the Technician and whether a
 * new users row was inserted.
 */
export async function addTechnicianTx(
  tx: Tx,
  input: AddTechnicianInput,
  opts: { id?: string; actor?: string; idempotencyKey?: string | null } = {}
): Promise<{ technician: Technician; created: boolean }> {
  const name = (input?.name ?? "").trim();
  const email = normalizeEmail(input?.email ?? "");
  assertValid(name, email);

  let userId = await userIdByEmail(tx, email);
  let created = false;
  if (userId) {
    if (await hasRole(tx, userId, TECHNICIAN_ROLE)) {
      throw new TechnicianError(`a technician with email ${email} already exists`);
    }
    // Existing person (no technician role yet) → promote; the caller's name wins.
    await tx`update public.users set name = ${name}, active = true
             where tenant_id = public.app_tenant_id() and id = ${userId}`;
  } else {
    const rows = await tx<{ id: string }[]>`
      insert into public.users (id, tenant_id, name, email, active)
      values (coalesce(${opts.id ?? null}::uuid, public.uuidv7()), public.app_tenant_id(), ${name}, ${email}, true)
      returning id`;
    userId = rows[0].id;
    created = true;
  }
  await addRole(tx, userId, TECHNICIAN_ROLE);
  const technician = (await getTechnicianTx(tx, userId))!;
  await appendEvent(tx, {
    entity: "user",
    entityId: userId,
    eventType: created ? "technician.created" : "technician.promoted",
    payload: { name, email },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return { technician, created };
}

export async function updateTechnicianTx(
  tx: Tx,
  id: string,
  patch: UpdateTechnicianInput,
  opts: { actor?: string } = {}
): Promise<Technician | null> {
  const current = await getTechnicianTx(tx, id);
  if (!current) return null;

  const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
  const nextEmail = patch.email !== undefined ? normalizeEmail(patch.email) : current.email;
  assertValid(nextName, nextEmail);

  if (patch.email !== undefined && nextEmail !== normalizeEmail(current.email)) {
    const other = await userIdByEmail(tx, nextEmail);
    if (other && other !== id) throw new TechnicianError(`a technician with email ${nextEmail} already exists`);
  }
  const nextActive = patch.active !== undefined ? !!patch.active : current.active;

  await tx`
    update public.users
    set name = ${nextName}, email = ${nextEmail}, active = ${nextActive}
    where tenant_id = public.app_tenant_id() and id = ${id}`;
  const updated = (await getTechnicianTx(tx, id))!;
  await appendEvent(tx, {
    entity: "user",
    entityId: id,
    eventType: "technician.updated",
    payload: { patch: { name: patch.name, email: patch.email, active: patch.active } },
    actor: opts.actor ?? API_ACTOR,
  });
  return updated;
}

//------------------------------------------------------------------------------
// Public API — same signatures as the retired KV module
//------------------------------------------------------------------------------

/** List technicians. Pass { activeOnly: true } for the WO pick-list. */
export async function listTechnicians(env: Env, opts: { activeOnly?: boolean } = {}): Promise<Technician[]> {
  return withTenantRead(env, tenantOf(env), (tx) => listTechniciansTx(tx, opts));
}

/** Add a technician. Rejects duplicates by email (case-insensitive). */
export async function addTechnician(env: Env, input: AddTechnicianInput): Promise<Technician> {
  const r = await withTenant(env, tenantOf(env), (tx) => addTechnicianTx(tx, input));
  return r.technician;
}

/** Edit a technician's name/email and/or toggle active. Returns null if id unknown. */
export async function updateTechnician(env: Env, id: string, patch: UpdateTechnicianInput): Promise<Technician | null> {
  return withTenant(env, tenantOf(env), (tx) => updateTechnicianTx(tx, id, patch));
}

/**
 * Resolve a set of technician ids to their email addresses (active only) — used
 * when creating a WO to turn checked techs into calendar guests. Unknown/inactive
 * ids are silently skipped so a stale selection can't break event creation.
 */
export async function resolveGuestEmails(env: Env, technicianIds: string[]): Promise<string[]> {
  if (!technicianIds?.length) return [];
  const all = await listTechnicians(env, { activeOnly: true });
  const byId = new Map(all.map((t) => [t.id, t]));
  const emails: string[] = [];
  for (const id of technicianIds) {
    const t = byId.get(id);
    if (t && t.active && t.email) emails.push(t.email);
  }
  return emails;
}
