//==============================================================================
// repo/projects.ts — the client SITE projects on Postgres (P2).
//
// Routes served (Postgres-backed tenants, see backend-mode.ts):
//   GET  /projects?q=&all=        → listProjects()        (ProjectHit[])
//   PUT  /projects/:pid/membership → setProjectMembership()
//   + the access-code write-back POST/PATCH /work-orders … accessCodes (updateAccessCodesTx)
//
// `:pid` is projects.id (uuid). A Zoho project id (external_ids) is also accepted
// so an old deep link keeps resolving after the P3a import. Every write appends
// an events row; pick-list values auto-create their status_vocab row (ensureVocab).
//==============================================================================

import type { AccessCodes, Env } from "../types";
import { isUuid, withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { ZOHO_SYSTEMS } from "../backend";
import { API_ACTOR, ensureVocab, findByExternalId, tenantOf } from "./_shared";
import { serializeProject, type ProjectHit, type ProjectRow } from "../serialize/project";

export type { ProjectHit };

const PROJECT_COLS = [
  "id", "public_key", "name", "client_name", "is_service", "site_address", "site_city", "site_state", "site_zip",
  "membership_level", "gate_code", "community_gate", "door_code", "custom",
] as const;

export interface ProjectRecord extends ProjectRow {
  gate_code: string | null;
  community_gate: string | null;
  door_code: string | null;
}

//------------------------------------------------------------------------------
// Transaction-level primitives
//------------------------------------------------------------------------------

/** projects.id for a wire project id (our uuid, or a legacy Zoho project id), or null. */
export async function resolveProjectId(tx: Tx, id: string): Promise<string | null> {
  const key = String(id ?? "").trim();
  if (!key) return null;
  if (isUuid(key)) {
    const rows = await tx<{ id: string }[]>`
      select id from public.projects
      where tenant_id = public.app_tenant_id() and id = ${key} and deleted_at is null limit 1`;
    if (rows.length) return rows[0].id;
  }
  return findByExternalId(tx, "project", ZOHO_SYSTEMS.project, key);
}

export async function getProjectTx(tx: Tx, id: string): Promise<ProjectRecord | null> {
  const pid = await resolveProjectId(tx, id);
  if (!pid) return null;
  const rows = await tx<ProjectRecord[]>`
    select ${tx(PROJECT_COLS)} from public.projects
    where tenant_id = public.app_tenant_id() and id = ${pid} and deleted_at is null limit 1`;
  return rows.length ? rows[0] : null;
}

/**
 * The picker / Projects-dashboard list. `q` = case-insensitive substring over the
 * name, key, client and site address (the Zoho search was a name search; the
 * extra columns are a superset). SERVICE projects only unless includeAll.
 */
export async function listProjectsTx(tx: Tx, opts: { q?: string; includeAll?: boolean } = {}): Promise<ProjectHit[]> {
  const needle = (opts.q ?? "").trim();
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await tx<ProjectRow[]>`
    select ${tx(PROJECT_COLS)} from public.projects
    where tenant_id = public.app_tenant_id() and deleted_at is null
      and (${opts.includeAll === true} or is_service)
      and (${needle === ""} or name ilike ${like} or public_key ilike ${like}
           or coalesce(client_name, '') ilike ${like} or coalesce(site_address, '') ilike ${like})
    order by name asc, public_key asc`;
  return rows.map(serializeProject);
}

/** Set the support-membership level (vocab domain membership-type; "" clears). Returns false when the project is unknown. */
export async function setMembershipTx(tx: Tx, id: string, value: string, opts: { actor?: string } = {}): Promise<boolean> {
  const project = await getProjectTx(tx, id);
  if (!project) return false;
  const v = (value ?? "").trim();
  if (v) await ensureVocab(tx, "membership-type", v);
  await tx`
    update public.projects set membership_level = ${v || null}
    where tenant_id = public.app_tenant_id() and id = ${project.id}`;
  await appendEvent(tx, {
    entity: "project",
    entityId: project.id,
    eventType: "project.membership_set",
    payload: { from: project.membership_level, to: v || null },
    actor: opts.actor ?? API_ACTOR,
  });
  return true;
}

/** Write the site access codes (only the supplied keys change). Returns the resulting codes. */
export async function updateAccessCodesTx(
  tx: Tx,
  projectId: string,
  codes: Partial<AccessCodes>,
  opts: { actor?: string } = {}
): Promise<AccessCodes> {
  const project = await getProjectTx(tx, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  const next: AccessCodes = {
    gate_code: codes.gate_code !== undefined ? codes.gate_code || null : project.gate_code,
    community_gate: codes.community_gate !== undefined ? codes.community_gate || null : project.community_gate,
    door_code: codes.door_code !== undefined ? codes.door_code || null : project.door_code,
  };
  await tx`
    update public.projects
    set gate_code = ${next.gate_code}, community_gate = ${next.community_gate}, door_code = ${next.door_code}
    where tenant_id = public.app_tenant_id() and id = ${project.id}`;
  await appendEvent(tx, {
    entity: "project",
    entityId: project.id,
    eventType: "project.access_codes_updated",
    payload: { patch: codes },
    actor: opts.actor ?? API_ACTOR,
  });
  return next;
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts
//------------------------------------------------------------------------------

export async function listProjects(env: Env, opts: { q?: string; includeAll?: boolean } = {}): Promise<ProjectHit[]> {
  return withTenantRead(env, tenantOf(env), (tx) => listProjectsTx(tx, opts));
}

export async function getProject(env: Env, id: string): Promise<ProjectHit | null> {
  return withTenantRead(env, tenantOf(env), async (tx) => {
    const p = await getProjectTx(tx, id);
    return p ? serializeProject(p) : null;
  });
}

export async function setProjectMembership(env: Env, id: string, value: string): Promise<boolean> {
  return withTenant(env, tenantOf(env), (tx) => setMembershipTx(tx, id, value));
}
