//==============================================================================
// backend.ts — the Backend adapter interface + the Zoho adapter (F2).
//
// Design (ratified): our Postgres is the system of record; foreign systems
// (Zoho Projects/CRM today, Books/CompanyCam later) sit BEHIND this interface.
// There is no bidirectional mirror — a backend either PULLs records in (import
// / reconcile, cursor-based) or receives PUSHed domain events (fan-out from
// the events table). External ids live ONLY in external_ids (0001 §2).
//
// F2 scope: the interface, a THIN ZohoBackend that delegates to the existing
// zoho.ts functions unchanged, and a registry with only "zoho". No existing
// route is touched — service.ts keeps calling zoho.ts directly until each
// module's cutover row moves it behind this adapter.
//==============================================================================

import type { Env } from "./types";
import type { Tx } from "./db";
import * as zoho from "./zoho";

/** A record as a backend hands it to us (before mapping onto a domain row). */
export interface ExternalRecord {
  /** Singular entity name: project, work_order, user, contact, … (external_ids.entity). */
  entity: string;
  /** The backend's own id for it (external_ids.external_id). */
  externalId: string;
  /** external_ids.system this id belongs to (e.g. zoho_projects_project). */
  system: string;
  /** Raw backend payload — mapping to a domain row is the importer's job (P3a). */
  data: Record<string, unknown>;
  /** Backend-side last-modified when known (ISO string). */
  modifiedAt?: string | null;
}

export interface PullResult {
  records: ExternalRecord[];
  /** Opaque cursor for the next page; null when exhausted. */
  nextCursor: string | null;
}

/** A domain event as stored in `events` (see events.ts appendEvent). */
export interface DomainEvent {
  id: string;
  tenantId: string;
  entity: string;
  entityId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  actor: string | null;
  occurredAt: Date;
}

export interface Backend {
  /** Registry name: "zoho" (later "books", "companycam", …). */
  name: string;
  /** Page through the backend's records from `cursor` (null = start). */
  pull(cursor: string | null): Promise<PullResult>;
  /** Apply one domain event to the backend (idempotent per event id). */
  push(event: DomainEvent): Promise<void>;
  /** external id → our uuid via external_ids, or null when unmapped. */
  resolveExternalId(entity: string, externalId: string): Promise<string | null>;
}

export class BackendNotImplemented extends Error {
  constructor(backend: string, op: string) {
    super(`${backend} backend: ${op} is not implemented yet`);
    this.name = "BackendNotImplemented";
  }
}

//------------------------------------------------------------------------------
// Zoho adapter
//------------------------------------------------------------------------------

/**
 * external_ids.system per entity for Zoho (0001 comment on external_ids.system).
 * Anything not listed defaults to `zoho_projects_<entity>`.
 */
export const ZOHO_SYSTEMS: Record<string, string> = {
  project: "zoho_projects_project",
  work_order: "zoho_projects_task_action",
  wo_task: "zoho_projects_task",
  todo: "zoho_projects_task",
  item: "zoho_projects_task",
  user: "zoho_projects_user",
  action_item: "zoho_projects_issue",
  forum: "zoho_projects_forum",
  forum_category: "zoho_projects_forum_category",
  forum_comment: "zoho_projects_forum_comment",
  contact: "zoho_crm_contact",
  account: "zoho_crm_account",
  deal: "zoho_crm_deal",
};

export function zohoSystemFor(entity: string): string {
  return ZOHO_SYSTEMS[entity] ?? `zoho_projects_${entity}`;
}

/**
 * Thin wrapper over zoho.ts. Reads (pull/lookups) delegate to the existing
 * functions; `tx` is required only for resolveExternalId (it reads our DB).
 */
export class ZohoBackend implements Backend {
  readonly name = "zoho";

  constructor(private readonly env: Env, private readonly tx?: Tx) {}

  // TODO(P3a): cursor = "<phase>:<page>" over listServiceProjects → tasks → issues → forums,
  // mapping each to ExternalRecord. Deliberately not implemented in F2 (no importer yet).
  async pull(_cursor: string | null): Promise<PullResult> {
    throw new BackendNotImplemented(this.name, "pull");
  }

  // TODO(P3a): switch on event.eventType (work_order.created → createTask …). In F2 the
  // existing routes still write Zoho directly through service.ts, so pushing here would
  // create a SECOND write path — refuse instead of double-writing.
  async push(event: DomainEvent): Promise<void> {
    throw new BackendNotImplemented(this.name, `push(${event.eventType})`);
  }

  async resolveExternalId(entity: string, externalId: string): Promise<string | null> {
    if (!this.tx) throw new Error("ZohoBackend.resolveExternalId needs a transaction (getBackend(env, 'zoho', tx)).");
    const rows = await this.tx<{ entity_id: string }[]>`
      select entity_id from public.external_ids
      where tenant_id = public.app_tenant_id()
        and entity = ${entity} and system = ${zohoSystemFor(entity)} and external_id = ${externalId}
      limit 1`;
    return rows.length ? rows[0].entity_id : null;
  }

  // --- Pass-throughs to zoho.ts (unchanged behaviour) -------------------------

  listServiceProjects(opts: { refresh?: boolean } = {}): Promise<zoho.ZohoProject[]> {
    return zoho.listServiceProjects(this.env, opts);
  }
  getProject(projectId: string): Promise<zoho.ZohoProject> {
    return zoho.getProject(this.env, projectId);
  }
  getTask(projectId: string, taskId: string): Promise<zoho.ZohoTask> {
    return zoho.getTask(this.env, projectId, taskId);
  }
  getPortalUsers(): ReturnType<typeof zoho.getPortalUsers> {
    return zoho.getPortalUsers(this.env);
  }
}

//------------------------------------------------------------------------------
// Registry
//------------------------------------------------------------------------------

export type BackendName = "zoho";

export function getBackend(env: Env, name: BackendName | string, tx?: Tx): Backend {
  switch (name) {
    case "zoho":
      return new ZohoBackend(env, tx);
    default:
      throw new Error(`unknown backend "${name}" (registered: zoho)`);
  }
}
