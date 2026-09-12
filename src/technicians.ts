//==============================================================================
// technicians.ts — the managed Technicians registry (name + email + active).
//
// Powers the work-order "Assign technicians" pick-list. Checked techs are added
// as GUESTS on the single calendar event. NOTHING is pre-populated or hardcoded:
// the list starts empty and the office builds it in-app (Manage Technicians).
//
// Storage: one JSON array under the KV key `technicians` in WO_KV. Fine for the
// interim (a small, low-write list). Upgrade path: a Cloudflare D1 table with the
// same shape if it grows or needs more fields — callers use these functions, not
// the store directly, so swapping is contained here.
//==============================================================================

import type { Env } from "./types";

const KV_KEY = "technicians";

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
// Store helpers (the only place that touches KV)
//------------------------------------------------------------------------------
async function readAll(env: Env): Promise<Technician[]> {
  const raw = await env.WO_KV.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Technician[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt value shouldn't take the endpoint down — treat as empty.
    return [];
  }
}

async function writeAll(env: Env, techs: Technician[]): Promise<void> {
  await env.WO_KV.put(KV_KEY, JSON.stringify(techs));
}

//------------------------------------------------------------------------------
// Validation
//------------------------------------------------------------------------------
// Deliberately permissive: real-world addresses vary. Just require x@y.z shape.
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
// Public API
//------------------------------------------------------------------------------
/** List technicians. Pass { activeOnly: true } for the WO pick-list. */
export async function listTechnicians(
  env: Env,
  opts: { activeOnly?: boolean } = {}
): Promise<Technician[]> {
  const all = await readAll(env);
  const list = opts.activeOnly ? all.filter((t) => t.active) : all;
  // Stable, human-friendly ordering for the UI.
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** Add a technician. Rejects duplicates by email (case-insensitive). */
export async function addTechnician(env: Env, input: AddTechnicianInput): Promise<Technician> {
  const name = (input?.name ?? "").trim();
  const email = normalizeEmail(input?.email ?? "");
  assertValid(name, email);

  const all = await readAll(env);
  if (all.some((t) => normalizeEmail(t.email) === email)) {
    throw new TechnicianError(`a technician with email ${email} already exists`);
  }

  const now = new Date().toISOString();
  const tech: Technician = {
    id: crypto.randomUUID(),
    name,
    email,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  all.push(tech);
  await writeAll(env, all);
  return tech;
}

/** Edit a technician's name/email and/or toggle active. Returns null if id unknown. */
export async function updateTechnician(
  env: Env,
  id: string,
  patch: UpdateTechnicianInput
): Promise<Technician | null> {
  const all = await readAll(env);
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;

  const current = all[idx];
  const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
  const nextEmail = patch.email !== undefined ? normalizeEmail(patch.email) : current.email;
  assertValid(nextName, nextEmail);

  // If email changed, keep it unique.
  if (
    patch.email !== undefined &&
    normalizeEmail(patch.email) !== normalizeEmail(current.email) &&
    all.some((t) => t.id !== id && normalizeEmail(t.email) === nextEmail)
  ) {
    throw new TechnicianError(`a technician with email ${nextEmail} already exists`);
  }

  const updated: Technician = {
    ...current,
    name: nextName,
    email: nextEmail,
    active: patch.active !== undefined ? !!patch.active : current.active,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  await writeAll(env, all);
  return updated;
}

/**
 * Resolve a set of technician ids to their email addresses (active only) — used
 * when creating a WO to turn checked techs into calendar guests. Unknown/inactive
 * ids are silently skipped so a stale selection can't break event creation.
 */
export async function resolveGuestEmails(env: Env, technicianIds: string[]): Promise<string[]> {
  if (!technicianIds?.length) return [];
  const all = await readAll(env);
  const byId = new Map(all.map((t) => [t.id, t]));
  const emails: string[] = [];
  for (const id of technicianIds) {
    const t = byId.get(id);
    if (t && t.active) emails.push(t.email);
  }
  return emails;
}
