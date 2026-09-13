//==============================================================================
// repo/people.ts — the managed People registry on Postgres (F3).
//
// Replaces src/people.ts (KV key `people`). Same exported functions and the
// same wire shape (Person = {id, name, email, active, zohoUser, createdAt,
// updatedAt}; email "" when unset; zohoUser null when unset).
//
// Storage (F1 §8.6 + Craig's 2026-09-13 answer 5): v_people = ALL non-deleted
// users regardless of role, so a "person" created here is simply a users row
// with NO user_roles row (decision: no special role — roles are tenant-custom
// and the legacy People registry had none). Technicians therefore also appear
// in GET /people, which is the unified model working as designed.
//==============================================================================

import type { Env } from "../types";
import { withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { API_ACTOR, iso, tenantOf } from "./_shared";

export interface Person {
  id: string;
  name: string;
  /** Optional — a person doesn't need an email to be an assignee. "" when unset. */
  email: string;
  active: boolean;
  /** The Zoho PROJECTS "users" pick-list LABEL (documentation linkage only). null when unset. */
  zohoUser: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddPersonInput {
  name: string;
  email?: string;
  zohoUser?: string | null;
}

export interface UpdatePersonInput {
  name?: string;
  email?: string;
  active?: boolean;
  zohoUser?: string | null;
}

/** Thrown for bad input (missing name, invalid email, duplicate name). Mapped to 400. */
export class PersonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonError";
  }
}

//------------------------------------------------------------------------------
// Validation (unchanged from the KV module)
//------------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeZohoUser(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

function assertValid(name: string, email: string): void {
  if (!name || !name.trim()) throw new PersonError("name is required");
  if (email && !EMAIL_RE.test(email.trim())) throw new PersonError(`invalid email: '${email}'`);
}

//------------------------------------------------------------------------------
// Rows → wire
//------------------------------------------------------------------------------
interface PersonRow {
  id: string;
  name: string;
  email: string;
  active: boolean;
  zoho_user: string | null;
  created_at: Date;
  updated_at: Date;
}

function toPerson(r: PersonRow): Person {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? "",
    active: !!r.active,
    zohoUser: normalizeZohoUser(r.zoho_user),
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

const V_COLS = ["id", "name", "email", "active", "zoho_user", "created_at", "updated_at"] as const;

//------------------------------------------------------------------------------
// Transaction-level primitives (shared with scripts/import-kv.ts)
//------------------------------------------------------------------------------

export async function getPeopleTx(tx: Tx, opts: { activeOnly?: boolean } = {}): Promise<Person[]> {
  const rows = await tx<PersonRow[]>`
    select ${tx(V_COLS)} from public.v_people
    where tenant_id = public.app_tenant_id() ${opts.activeOnly ? tx`and active = true` : tx``}
    order by name asc`;
  return rows.map(toPerson).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPersonTx(tx: Tx, id: string): Promise<Person | null> {
  const rows = await tx<PersonRow[]>`
    select ${tx(V_COLS)} from public.v_people
    where tenant_id = public.app_tenant_id() and id = ${id}
    limit 1`;
  return rows.length ? toPerson(rows[0]) : null;
}

async function userIdByName(tx: Tx, name: string): Promise<string | null> {
  const rows = await tx<{ id: string }[]>`
    select id from public.users
    where tenant_id = public.app_tenant_id() and deleted_at is null and lower(name) = ${normalizeName(name)}
    limit 1`;
  return rows.length ? rows[0].id : null;
}

async function userIdByEmail(tx: Tx, email: string): Promise<string | null> {
  if (!email) return null;
  const rows = await tx<{ id: string }[]>`
    select id from public.users
    where tenant_id = public.app_tenant_id() and deleted_at is null and lower(email) = ${email}
    limit 1`;
  return rows.length ? rows[0].id : null;
}

/** Create a person. `opts.id` lets the importer keep the legacy KV id. */
export async function savePersonTx(
  tx: Tx,
  input: AddPersonInput,
  opts: { id?: string; actor?: string; idempotencyKey?: string | null } = {}
): Promise<Person> {
  const name = (input?.name ?? "").trim();
  const email = (input?.email ?? "").trim().toLowerCase();
  assertValid(name, email);

  if (await userIdByName(tx, name)) throw new PersonError(`a person named ${name} already exists`);
  if (email && (await userIdByEmail(tx, email))) throw new PersonError(`a person with email ${email} already exists`);

  const zohoUser = normalizeZohoUser(input?.zohoUser);
  const rows = await tx<{ id: string }[]>`
    insert into public.users (id, tenant_id, name, email, active, zoho_user)
    values (coalesce(${opts.id ?? null}::uuid, public.uuidv7()), public.app_tenant_id(), ${name}, ${email || null}, true, ${zohoUser})
    returning id`;
  const person = (await getPersonTx(tx, rows[0].id))!;
  await appendEvent(tx, {
    entity: "user",
    entityId: person.id,
    eventType: "person.created",
    payload: { name, email, zohoUser },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return person;
}

export async function updatePersonTx(
  tx: Tx,
  id: string,
  patch: UpdatePersonInput,
  opts: { actor?: string } = {}
): Promise<Person | null> {
  const current = await getPersonTx(tx, id);
  if (!current) return null;

  const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
  const nextEmail = patch.email !== undefined ? patch.email.trim().toLowerCase() : current.email;
  assertValid(nextName, nextEmail);

  if (patch.name !== undefined && normalizeName(nextName) !== normalizeName(current.name)) {
    const other = await userIdByName(tx, nextName);
    if (other && other !== id) throw new PersonError(`a person named ${nextName} already exists`);
  }
  if (patch.email !== undefined && nextEmail && nextEmail !== current.email) {
    const other = await userIdByEmail(tx, nextEmail);
    if (other && other !== id) throw new PersonError(`a person with email ${nextEmail} already exists`);
  }
  // Missing on update = leave unchanged; explicit null/"" = clear (→ null).
  const nextZohoUser = patch.zohoUser !== undefined ? normalizeZohoUser(patch.zohoUser) : current.zohoUser;
  const nextActive = patch.active !== undefined ? !!patch.active : current.active;

  await tx`
    update public.users
    set name = ${nextName}, email = ${nextEmail || null}, active = ${nextActive}, zoho_user = ${nextZohoUser}
    where tenant_id = public.app_tenant_id() and id = ${id}`;
  const updated = (await getPersonTx(tx, id))!;
  await appendEvent(tx, {
    entity: "user",
    entityId: id,
    eventType: "person.updated",
    payload: { patch: { name: patch.name, email: patch.email, active: patch.active, zohoUser: patch.zohoUser } },
    actor: opts.actor ?? API_ACTOR,
  });
  return updated;
}

//------------------------------------------------------------------------------
// Public API — same signatures as the retired KV module
//------------------------------------------------------------------------------

/** List people. Pass { activeOnly: true } for the assignee pick-list. */
export async function getPeople(env: Env, opts: { activeOnly?: boolean } = {}): Promise<Person[]> {
  return withTenantRead(env, tenantOf(env), (tx) => getPeopleTx(tx, opts));
}

/** Add a person. Rejects duplicates by name (case-insensitive); email is optional. */
export async function savePerson(env: Env, input: AddPersonInput): Promise<Person> {
  return withTenant(env, tenantOf(env), (tx) => savePersonTx(tx, input));
}

/** Edit a person's name/email and/or toggle active. Returns null if id unknown. */
export async function updatePerson(env: Env, id: string, patch: UpdatePersonInput): Promise<Person | null> {
  return withTenant(env, tenantOf(env), (tx) => updatePersonTx(tx, id, patch));
}
