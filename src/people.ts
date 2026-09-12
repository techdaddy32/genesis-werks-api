//==============================================================================
// people.ts — the managed People registry (name + optional email + active).
//
// Powers the to-do "Assignee" pick-list. NOTHING is pre-populated or hardcoded:
// the list starts empty and the office builds it in-app (Manage People). The
// registry only POPULATES the choices — an assignee is stored as FREE TEXT on the
// todo (in the description token), so it is never hard-validated against this list.
//
// Storage: one JSON array under the KV key `people` in WO_KV — mirrors the
// technicians registry (technicians.ts). Same upgrade path (a D1 table) applies.
//==============================================================================

import type { Env } from "./types";

const KV_KEY = "people";

export interface Person {
  id: string;
  name: string;
  /** Optional — a person doesn't need an email to be an assignee. "" when unset. */
  email: string;
  active: boolean;
  /**
   * The ONE Zoho PROJECTS "users" pick-list value that matches this person, stored
   * as a plain string for documentation linkage only (NO Zoho reads/writes). Free
   * text — NOT hard-validated against the options list (like the todo assignee).
   * null when unset. Chosen from AdminConfig.zohoUserOptions in the UI.
   */
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
// Store helpers (the only place that touches KV)
//------------------------------------------------------------------------------
async function readAll(env: Env): Promise<Person[]> {
  const raw = await env.WO_KV.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Person[];
    if (!Array.isArray(parsed)) return [];
    // Backfill zohoUser for records saved before the field existed (→ null).
    return parsed.map((p) => ({ ...p, zohoUser: normalizeZohoUser(p?.zohoUser) }));
  } catch {
    // Corrupt value shouldn't take the endpoint down — treat as empty.
    return [];
  }
}

async function writeAll(env: Env, people: Person[]): Promise<void> {
  await env.WO_KV.put(KV_KEY, JSON.stringify(people));
}

//------------------------------------------------------------------------------
// Validation
//------------------------------------------------------------------------------
// Deliberately permissive: real-world addresses vary. Just require x@y.z shape.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Normalize a zohoUser value: trim; empty/nullish → null. Free text, not validated. */
function normalizeZohoUser(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

function assertValid(name: string, email: string): void {
  if (!name || !name.trim()) throw new PersonError("name is required");
  // Email is OPTIONAL for a person; validate the shape only when one is supplied.
  if (email && !EMAIL_RE.test(email.trim())) throw new PersonError(`invalid email: '${email}'`);
}

//------------------------------------------------------------------------------
// Public API
//------------------------------------------------------------------------------
/** List people. Pass { activeOnly: true } for the assignee pick-list. */
export async function getPeople(env: Env, opts: { activeOnly?: boolean } = {}): Promise<Person[]> {
  const all = await readAll(env);
  const list = opts.activeOnly ? all.filter((p) => p.active) : all;
  // Stable, human-friendly ordering for the UI.
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** Add a person. Rejects duplicates by name (case-insensitive); email is optional. */
export async function savePerson(env: Env, input: AddPersonInput): Promise<Person> {
  const name = (input?.name ?? "").trim();
  const email = (input?.email ?? "").trim().toLowerCase();
  assertValid(name, email);

  const all = await readAll(env);
  if (all.some((p) => normalizeName(p.name) === normalizeName(name))) {
    throw new PersonError(`a person named ${name} already exists`);
  }

  const now = new Date().toISOString();
  const person: Person = {
    id: crypto.randomUUID(),
    name,
    email,
    active: true,
    zohoUser: normalizeZohoUser(input?.zohoUser),
    createdAt: now,
    updatedAt: now,
  };
  all.push(person);
  await writeAll(env, all);
  return person;
}

/** Edit a person's name/email and/or toggle active. Returns null if id unknown. */
export async function updatePerson(
  env: Env,
  id: string,
  patch: UpdatePersonInput
): Promise<Person | null> {
  const all = await readAll(env);
  const idx = all.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const current = all[idx];
  const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
  const nextEmail = patch.email !== undefined ? patch.email.trim().toLowerCase() : current.email;
  assertValid(nextName, nextEmail);

  // If name changed, keep it unique (case-insensitive).
  if (
    patch.name !== undefined &&
    normalizeName(nextName) !== normalizeName(current.name) &&
    all.some((p) => p.id !== id && normalizeName(p.name) === normalizeName(nextName))
  ) {
    throw new PersonError(`a person named ${nextName} already exists`);
  }

  // Missing on update = leave unchanged; explicit null/"" = clear (→ null).
  const nextZohoUser =
    patch.zohoUser !== undefined ? normalizeZohoUser(patch.zohoUser) : current.zohoUser ?? null;

  const updated: Person = {
    ...current,
    name: nextName,
    email: nextEmail,
    active: patch.active !== undefined ? !!patch.active : current.active,
    zohoUser: nextZohoUser,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  await writeAll(env, all);
  return updated;
}
