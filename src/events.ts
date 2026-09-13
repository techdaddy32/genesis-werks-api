//==============================================================================
// events.ts — append-only event log + the internal fan-out webhook (F2).
//
// Table (0001 §2): events(id, tenant_id, entity, entity_id uuid NULL,
// event_type, payload jsonb, actor, idempotency_key, schema_version int,
// occurred_at, created_at). UPDATE/DELETE are blocked by trigger and revoked.
// Unique partial index events_idempotency_key_uidx (tenant_id, idempotency_key)
// WHERE idempotency_key IS NOT NULL — appendEvent() is idempotent on it.
//
// POST /internal/events/fanout — receives a Supabase Database Webhook (the
// `events` table INSERT) and fans it out to backends (Zoho/Cliq/…). STUB in
// this row: authenticates, parses, logs. Real routing lands with the Backend
// adapters (P3a).
//==============================================================================

import type { Env } from "./types";
import type { Tx } from "./db";

export interface AppendEventInput {
  /** Singular entity name (work_order, visit, item, …) — matches external_ids.entity. */
  entity: string;
  /** The row's uuid, or null for tenant-level events. */
  entityId?: string | null;
  /** Dotted verb, e.g. work_order.created, visit.calendar_failed. */
  eventType: string;
  payload?: Record<string, unknown>;
  /** User email, or system:cron / system:migration. */
  actor?: string | null;
  /** Optional caller key; a retry with the same key returns the existing row. */
  idempotencyKey?: string | null;
  /** Payload schema version (default 1). */
  schemaVersion?: number;
  /** When the thing happened; defaults to now() in the DB. */
  occurredAt?: Date | null;
}

export interface EventRow {
  id: string;
  tenant_id: string;
  entity: string;
  entity_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  actor: string | null;
  idempotency_key: string | null;
  schema_version: number;
  occurred_at: Date;
  created_at: Date;
}

export interface AppendEventResult {
  event: EventRow;
  /** false when the idempotency key already existed and the stored row is returned. */
  inserted: boolean;
}

const EVENT_COLS = [
  "id", "tenant_id", "entity", "entity_id", "event_type", "payload", "actor",
  "idempotency_key", "schema_version", "occurred_at", "created_at",
] as const;

/** Append one event for the transaction's tenant. Idempotent on idempotencyKey. */
export async function appendEvent(tx: Tx, input: AppendEventInput): Promise<AppendEventResult> {
  if (!input.entity) throw new Error("appendEvent: entity is required.");
  if (!input.eventType) throw new Error("appendEvent: eventType is required.");
  const key = input.idempotencyKey ?? null;
  const payload = input.payload ?? {};
  const schemaVersion = input.schemaVersion ?? 1;

  const inserted = await tx<EventRow[]>`
    insert into public.events
      (tenant_id, entity, entity_id, event_type, payload, actor, idempotency_key, schema_version, occurred_at)
    values
      (public.app_tenant_id(), ${input.entity}, ${input.entityId ?? null}, ${input.eventType},
       ${tx.json(payload as never)}, ${input.actor ?? null}, ${key}, ${schemaVersion},
       coalesce(${input.occurredAt ?? null}, now()))
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
    returning ${tx(EVENT_COLS)}`;
  if (inserted.length === 1) return { event: inserted[0], inserted: true };

  // Conflict → return the row already stored under this key.
  const existing = await tx<EventRow[]>`
    select ${tx(EVENT_COLS)} from public.events
    where tenant_id = public.app_tenant_id() and idempotency_key = ${key}
    limit 1`;
  if (existing.length !== 1) throw new Error("appendEvent: insert skipped but no existing row found for the idempotency key.");
  return { event: existing[0], inserted: false };
}

/** Recent events for one entity (newest first). */
export async function listEntityEvents(tx: Tx, entity: string, entityId: string, limit = 50): Promise<EventRow[]> {
  return tx<EventRow[]>`
    select ${tx(EVENT_COLS)} from public.events
    where tenant_id = public.app_tenant_id() and entity = ${entity} and entity_id = ${entityId}
    order by occurred_at desc, created_at desc
    limit ${limit}`;
}

//------------------------------------------------------------------------------
// POST /internal/events/fanout (stub)
//------------------------------------------------------------------------------

export const INTERNAL_TOKEN_HEADER = "X-Internal-Token";

/** Supabase Database Webhook payload (https://supabase.com/docs/guides/database/webhooks). */
export interface SupabaseWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

export interface FanoutResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Constant-time string equality (both sides compared over the longer length). */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Guard + parse + log. Returns {status, body} so index.ts can wrap it in its
 * own json() helper. 503 when INTERNAL_TOKEN is unset (route disabled),
 * 401 on a bad token, 400 on a malformed payload, 202 when accepted.
 */
export async function handleEventFanout(request: Request, env: Env): Promise<FanoutResponse> {
  const expected = env.INTERNAL_TOKEN ?? "";
  if (!expected) return { status: 503, body: { error: "INTERNAL_TOKEN is not configured" } };
  const given = request.headers.get(INTERNAL_TOKEN_HEADER) ?? "";
  if (!safeEqual(given, expected)) return { status: 401, body: { error: "invalid internal token" } };

  let payload: SupabaseWebhookPayload;
  try {
    payload = (await request.json()) as SupabaseWebhookPayload;
  } catch {
    return { status: 400, body: { error: "body must be JSON" } };
  }
  if (!payload || typeof payload !== "object" || !payload.type || !payload.table) {
    return { status: 400, body: { error: "expected a Supabase database-webhook payload {type, table, schema, record, old_record}" } };
  }

  const rec = payload.record ?? {};
  const summary = {
    type: payload.type,
    schema: payload.schema,
    table: payload.table,
    eventId: typeof rec.id === "string" ? rec.id : null,
    tenantId: typeof rec.tenant_id === "string" ? rec.tenant_id : null,
    entity: typeof rec.entity === "string" ? rec.entity : null,
    eventType: typeof rec.event_type === "string" ? rec.event_type : null,
  };
  // STUB (F2): log only. TODO(P3a): route to getBackend(env, ...).push() per event_type.
  console.log("events.fanout:", JSON.stringify(summary));
  return { status: 202, body: { ok: true, accepted: summary, handled: false } };
}
