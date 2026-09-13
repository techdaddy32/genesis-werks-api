//==============================================================================
// settings.ts — tenant_settings access (F2).
//
// Table (0001 §2): tenant_settings(id, tenant_id, key, value jsonb, created_at,
// updated_at) UNIQUE (tenant_id, key). Scalars are stored as JSON scalars
// ("global"), lists as arrays, numbering.<kind> as objects.
//
// Every query runs inside a withTenant() transaction and ALSO filters on
// tenant_id = app_tenant_id() so the tenant scope holds even for a role that
// bypasses RLS. Keys are the exact strings 0002_seed_fhi.sql writes.
//==============================================================================

import type { Tx } from "./db";

//------------------------------------------------------------------------------
// Generic access
//------------------------------------------------------------------------------

/** One setting's parsed jsonb value, or undefined when the key is absent. */
export async function getSetting(tx: Tx, key: string): Promise<unknown> {
  const rows = await tx<{ value: unknown }[]>`
    select value from public.tenant_settings
    where tenant_id = public.app_tenant_id() and key = ${key}
    limit 1`;
  return rows.length ? rows[0].value : undefined;
}

/** Every setting whose key starts with `prefix` (e.g. "zoho."), as a key → value map. */
export async function getSettings(tx: Tx, prefix: string): Promise<Record<string, unknown>> {
  const rows = await tx<{ key: string; value: unknown }[]>`
    select key, value from public.tenant_settings
    where tenant_id = public.app_tenant_id() and key like ${prefix + "%"}
    order by key`;
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Upsert one setting (value is any JSON-serialisable value; stored as jsonb). */
export async function setSetting(tx: Tx, key: string, value: unknown): Promise<void> {
  await tx`
    insert into public.tenant_settings (tenant_id, key, value)
    values (public.app_tenant_id(), ${key}, ${tx.json(value as never)})
    on conflict (tenant_id, key) do update
      set value = excluded.value, updated_at = now()`;
}

//------------------------------------------------------------------------------
// numbering.<kind> — consumed by mint_public_key_parts() in the DB (keys.ts).
//------------------------------------------------------------------------------

export type NumberingScope = "global" | "per_project";

/** Shape of tenant_settings `numbering.<kind>` (seed: work_order / project / deal). */
export interface NumberingConfig {
  /** Tokens: {projectKey} {kind} {YYYY} {YY} {seq} {seqN} — e.g. "{projectKey}-WO-{YYYY}-{seq4}". */
  pattern: string;
  scope: NumberingScope;
  /** Zero-pad width for {seq}; 0 = none. */
  pad: number;
  yearly_reset: boolean;
}

export const numberingKey = (kind: string): string => `numbering.${kind}`;

export async function getNumbering(tx: Tx, kind: string): Promise<NumberingConfig | undefined> {
  const v = await getSetting(tx, numberingKey(kind));
  if (!v || typeof v !== "object") return undefined;
  const o = v as Partial<NumberingConfig>;
  return {
    pattern: String(o.pattern ?? ""),
    scope: o.scope === "per_project" ? "per_project" : "global",
    pad: Number.isFinite(Number(o.pad)) ? Number(o.pad) : 0,
    yearly_reset: o.yearly_reset === true,
  };
}

export async function setNumbering(tx: Tx, kind: string, cfg: NumberingConfig): Promise<void> {
  await setSetting(tx, numberingKey(kind), cfg);
}

//------------------------------------------------------------------------------
// Known keys (exactly as 0002_seed_fhi.sql writes them) with their value types.
//------------------------------------------------------------------------------

export interface KnownSettings {
  // zoho.* — all JSON strings
  "zoho.portal_id": string;
  "zoho.wo_field": string;
  "zoho.status_closed_id": string;
  "zoho.status_open_id": string;
  "zoho.visits_field": string;
  "zoho.nextvisit_field": string;
  "zoho.schedstatus_field": string;
  "zoho.wo_task_status_field": string;
  "zoho.billing_status_field": string;
  "zoho.wo_cycle_status_field": string;
  "zoho.used_items_field": string;
  "zoho.todo_status_field": string;
  "zoho.purchasing_project_id": string;
  "zoho.order_status_field": string;
  // calendar.*
  "calendar.default_id": string;      // calendars.id (uuid)
  "calendar.default_address": string; // Google calendar address
  /** P2: explicit off-switch for Google Calendar sync on the Postgres path (default: on iff default_address is set). */
  "calendar.enabled": boolean;
  // backend.* (P2, 0004) — which store serves the domain routes: "postgres" | "zoho" (default zoho)
  "backend.mode": "postgres" | "zoho";
  // app.*
  "app.origin": string;
  "app.wo_url_template": string;
  "app.timezone": string;
  // wo.*
  "wo.sequence_scope": NumberingScope;
  // admin.* — arrays (Setup page fills them in)
  "admin.report_access": string[];
  "admin.zoho_user_options": string[];
  "admin.scheduling_confirmer": string[];
}

export type KnownSettingKey = keyof KnownSettings;

/** Typed read of a seeded key. Returns undefined when unset (no defaults applied here). */
export async function getKnownSetting<K extends KnownSettingKey>(
  tx: Tx,
  key: K
): Promise<KnownSettings[K] | undefined> {
  const v = await getSetting(tx, key);
  return v === undefined || v === null ? undefined : (v as KnownSettings[K]);
}

/** Typed write of a seeded key. */
export async function setKnownSetting<K extends KnownSettingKey>(
  tx: Tx,
  key: K,
  value: KnownSettings[K]
): Promise<void> {
  await setSetting(tx, key, value);
}

type Prefixed<P extends string> = { [K in KnownSettingKey as K extends `${P}${string}` ? K : never]?: KnownSettings[K] };

/** All zoho.* keys the tenant has (typed by key). */
export async function getZohoSettings(tx: Tx): Promise<Prefixed<"zoho.">> {
  return (await getSettings(tx, "zoho.")) as Prefixed<"zoho.">;
}
export async function getCalendarSettings(tx: Tx): Promise<Prefixed<"calendar.">> {
  return (await getSettings(tx, "calendar.")) as Prefixed<"calendar.">;
}
export async function getAppSettings(tx: Tx): Promise<Prefixed<"app.">> {
  return (await getSettings(tx, "app.")) as Prefixed<"app.">;
}
export async function getAdminSettings(tx: Tx): Promise<Prefixed<"admin.">> {
  return (await getSettings(tx, "admin.")) as Prefixed<"admin.">;
}
