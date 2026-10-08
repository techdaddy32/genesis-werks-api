// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
//==============================================================================
// rules.ts — the Hybrid H field-rule engine (walk spec §5.5; HDS Hybrid H §5.4).
//
// shared.field_rules rows say "on_event X, when `condition` matches, do `action`".
// The engine runs IN THE WORKER, inside the SAME transaction that committed the
// event (push.ts calls it right after appendSyncEvent) — never a trigger, never
// PL/pgSQL (2026-09-13: the schema carries state and integrity, not business rules).
//
// Rules considered for an Organization: platform defaults (organization_id IS NULL,
// seeded by 060) + that Organization's own rows; enabled AND deleted_at IS NULL;
// ordered by sort_order. RLS already shapes the read that way (002 policy).
//
// `condition` is a flat jsonb object of {key: expectedValue}. The key `ref_table`
// matches the event's ref_table; every other key matches the SAME-NAMED column of the
// row the event is about (e.g. {"kind":"flag"} on places.location_notes). All keys must
// match (AND). An empty object matches everything.
//
// Actions (field_rules.action CHECK): `create_action_item` — one shared.action_items row
//   action_params: { source_kind (required, action_items CHECK), source_ref_table?
//                    (default = event ref_table), title_template? ("{{col}}" substituted
//                    from the row), project_from?: "row.project_id" | "walk.project_id" |
//                    "drawing.project_id" (falls back to the project push resolved) }
//   Idempotency: INSERT … ON CONFLICT (organization_id, source_kind, source_ref_id)
//   WHERE source_ref_id IS NOT NULL DO NOTHING — the partial UNIQUE in 002 is the second
//   half of idempotency (the first is events.idempotency_key). A duplicate push → one item.
//
// Tombstoned rows (deleted_at set) fire NO rule: a withdrawn flag must not mint an item.
//==============================================================================

import type { Tx } from "./org-context";
import { isUuid } from "./db";

export interface RuleEvent {
  organizationId: string;
  /** shared.members.id of the actor, or null for system. */
  actorId: string | null;
  eventType: string;
  refTable: string;
  refId: string;
  /** The row as stored after the write (merged existing + incoming). */
  row: Record<string, unknown>;
  /** The project the write path resolved for the row (may be null for drafts). */
  projectId: string | null;
}

export interface FieldRuleRow {
  id: string;
  organization_id: string | null;
  key: string;
  on_event: string;
  condition: Record<string, unknown> | null;
  action: string;
  action_params: Record<string, unknown> | null;
}

export interface RuleOutcome {
  ruleId: string;
  key: string;
  action: string;
  /** created = a new row; noop = the partial UNIQUE (or a NULL source_ref_id) prevented one; skipped = condition unmet / unsupported. */
  result: "created" | "noop" | "skipped";
  actionItemId?: string;
  detail?: string;
}

/** Load the rules that listen to `eventType` for the bound Organization (RLS-shaped: defaults + own). */
export async function loadRules(tx: Tx, organizationId: string, eventType: string): Promise<FieldRuleRow[]> {
  return tx<FieldRuleRow[]>`
    select id, organization_id, key, on_event, condition, action, action_params
      from shared.field_rules
     where on_event = ${eventType} and enabled and deleted_at is null
       and (organization_id is null or organization_id = ${organizationId})
     order by sort_order, key`;
}

/** Evaluate every matching rule for one committed event. Idempotent; safe to re-run on a replayed push. */
export async function evaluateRules(tx: Tx, ev: RuleEvent): Promise<RuleOutcome[]> {
  if (ev.row.deleted_at != null) return [];
  const rules = await loadRules(tx, ev.organizationId, ev.eventType);
  const out: RuleOutcome[] = [];
  for (const rule of rules) {
    if (!conditionMatches(rule.condition, ev)) {
      out.push({ ruleId: rule.id, key: rule.key, action: rule.action, result: "skipped", detail: "condition" });
      continue;
    }
    if (rule.action === "create_action_item") {
      out.push(await createActionItem(tx, ev, rule));
    } else {
      out.push({ ruleId: rule.id, key: rule.key, action: rule.action, result: "skipped", detail: `unsupported action ${rule.action}` });
    }
  }
  return out;
}

export function conditionMatches(condition: Record<string, unknown> | null | undefined, ev: RuleEvent): boolean {
  if (!condition || typeof condition !== "object") return true;
  for (const [k, expected] of Object.entries(condition)) {
    const actual = k === "ref_table" ? ev.refTable : k === "event_type" ? ev.eventType : ev.row[k];
    if (!looselyEqual(actual, expected)) return false;
  }
  return true;
}

function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

const SOURCE_KINDS = new Set(["field_flag", "verify_placement", "room_hint", "annotation_flag", "walk_reply"]);

async function createActionItem(tx: Tx, ev: RuleEvent, rule: FieldRuleRow): Promise<RuleOutcome> {
  const p = rule.action_params ?? {};
  const sourceKind = typeof p.source_kind === "string" ? p.source_kind : null;
  if (!sourceKind || !SOURCE_KINDS.has(sourceKind)) {
    return { ruleId: rule.id, key: rule.key, action: rule.action, result: "skipped", detail: "action_params.source_kind missing or not in the action_items CHECK" };
  }
  const sourceRefTable = typeof p.source_ref_table === "string" ? p.source_ref_table : ev.refTable;
  const projectId = await resolveProject(tx, ev, typeof p.project_from === "string" ? p.project_from : null);
  const title = renderTemplate(typeof p.title_template === "string" ? p.title_template : `${ev.eventType}: ${ev.refTable}`, ev.row).slice(0, 500);
  const description = typeof ev.row.body === "string" ? ev.row.body : null;
  const accountId = isUuid(ev.row.account_id) ? (ev.row.account_id as string) : null;

  const rows = await tx<{ id: string }[]>`
    insert into shared.action_items (organization_id, account_id, project_id, title, description, status,
                                     source_kind, source_ref_table, source_ref_id, rule_id, created_by,
                                     custom)
    values (${ev.organizationId}, ${accountId}, ${projectId}, ${title}, ${description}, 'open',
            ${sourceKind}, ${sourceRefTable}, ${ev.refId}, ${rule.id}, ${ev.actorId},
            ${tx.json({ event_type: ev.eventType, walk_id: ev.row.walk_id ?? null, room_id: ev.row.room_id ?? null, room_hint: ev.row.room_hint ?? null } as never)})
    on conflict (organization_id, source_kind, source_ref_id) where source_ref_id is not null do nothing
    returning id`;
  if (rows.length === 1) return { ruleId: rule.id, key: rule.key, action: rule.action, result: "created", actionItemId: rows[0].id };
  return { ruleId: rule.id, key: rule.key, action: rule.action, result: "noop", detail: "action item already exists for this source row" };
}

async function resolveProject(tx: Tx, ev: RuleEvent, from: string | null): Promise<string | null> {
  if (from === "row.project_id" && isUuid(ev.row.project_id)) return (ev.row.project_id as string).toLowerCase();
  if (from === "walk.project_id" && isUuid(ev.row.walk_id)) {
    const w = await tx<{ project_id: string | null }[]>`
      select project_id from places.walks where id = ${ev.row.walk_id as string} and organization_id = ${ev.organizationId}`;
    if (w[0]?.project_id) return w[0].project_id;
  }
  if (from === "drawing.project_id" && isUuid(ev.row.drawing_id)) {
    const d = await tx<{ project_id: string | null }[]>`
      select project_id from drawings.drawings where id = ${ev.row.drawing_id as string} and organization_id = ${ev.organizationId}`;
    if (d[0]?.project_id) return d[0].project_id;
  }
  if (isUuid(ev.row.project_id)) return (ev.row.project_id as string).toLowerCase();
  return ev.projectId;
}

/** "{{col}}" → String(row[col]) ("" when missing). */
export function renderTemplate(template: string, row: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const v = key.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), row);
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}
