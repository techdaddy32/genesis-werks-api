//==============================================================================
// field-definitions.ts — validate a row's `custom` jsonb against the tenant's
// field_definitions (F2). Every write path will call validateCustom() before
// persisting `custom`; NOT wired into any existing route in this row.
//
// Table (0001 §2): field_definitions(id, tenant_id, entity, key, label, type,
// options jsonb, required, sort_order, visible, group_name, help_text, …)
// UNIQUE (tenant_id, entity, key). `type` is CHECK-constrained to the 13
// FIELD_TYPES below. `options`: for picklist/multipicklist a JSON array of
// option strings OR {value,label} objects; for lookup {"entity": "..."}.
//
// Pure core (validateCustomAgainst) + a tx loader (loadFieldDefinitions) so
// the rules are unit-testable without a database.
//==============================================================================

import type { Tx } from "./db";
import { isUuid } from "./db";

export const FIELD_TYPES = [
  "text", "number", "date", "datetime", "boolean", "picklist", "multipicklist",
  "url", "phone", "email", "lookup", "currency", "textarea",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type PicklistOption = string | { value: string; label?: string };

export interface FieldDefinition {
  id?: string;
  entity: string;
  key: string;
  label: string;
  type: FieldType;
  /** picklist/multipicklist: PicklistOption[]; lookup: {entity}; otherwise []. */
  options: unknown;
  required: boolean;
  sort_order?: number;
  visible?: boolean;
  group_name?: string | null;
  help_text?: string | null;
}

export interface FieldError {
  key: string;
  code:
    | "unknown_field"
    | "required"
    | "type"
    | "picklist"
    | "format"
    | "lookup";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: FieldError[];
}

export interface ValidateOptions {
  /** Accept keys with no definition (default false: every custom key must be defined). */
  allowUnknown?: boolean;
}

//------------------------------------------------------------------------------
// Loader
//------------------------------------------------------------------------------

/** All definitions for one entity of the transaction's tenant (visible or not), in sort order. */
export async function loadFieldDefinitions(tx: Tx, entity: string): Promise<FieldDefinition[]> {
  return tx<FieldDefinition[]>`
    select id, entity, key, label, type, options, required, sort_order, visible, group_name, help_text
    from public.field_definitions
    where tenant_id = public.app_tenant_id() and entity = ${entity}
    order by sort_order, key`;
}

/** Load the entity's definitions and validate `custom` against them. */
export async function validateCustom(
  tx: Tx,
  entity: string,
  custom: Record<string, unknown>,
  opts: ValidateOptions = {}
): Promise<ValidationResult> {
  const defs = await loadFieldDefinitions(tx, entity);
  return validateCustomAgainst(defs, custom, opts);
}

//------------------------------------------------------------------------------
// Pure core
//------------------------------------------------------------------------------

/** Validate `custom` against already-loaded definitions. No I/O. */
export function validateCustomAgainst(
  defs: readonly FieldDefinition[],
  custom: Record<string, unknown> | null | undefined,
  opts: ValidateOptions = {}
): ValidationResult {
  const errors: FieldError[] = [];
  const values = custom ?? {};
  if (typeof values !== "object" || Array.isArray(values)) {
    return { ok: false, errors: [{ key: "", code: "type", message: "custom must be a JSON object" }] };
  }

  const byKey = new Map<string, FieldDefinition>();
  for (const d of defs) byKey.set(d.key, d);

  if (!opts.allowUnknown) {
    for (const k of Object.keys(values)) {
      if (!byKey.has(k)) errors.push({ key: k, code: "unknown_field", message: `"${k}" is not a defined field` });
    }
  }

  for (const def of defs) {
    const v = values[def.key];
    if (isEmpty(v)) {
      if (def.required) errors.push({ key: def.key, code: "required", message: `${def.label} is required` });
      continue;
    }
    const err = checkValue(def, v);
    if (err) errors.push(err);
  }

  return { ok: errors.length === 0, errors };
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits with optional leading +, and any spacing/punctuation; 7–15 digits (E.164 max).
const PHONE_RE = /^\+?[\d\s().-]{7,25}$/;

function checkValue(def: FieldDefinition, v: unknown): FieldError | null {
  const bad = (code: FieldError["code"], message: string): FieldError => ({ key: def.key, code, message });
  switch (def.type) {
    case "text":
    case "textarea":
      return typeof v === "string" ? null : bad("type", `${def.label} must be text`);

    case "number":
    case "currency":
      return typeof v === "number" && Number.isFinite(v) ? null : bad("type", `${def.label} must be a number`);

    case "boolean":
      return typeof v === "boolean" ? null : bad("type", `${def.label} must be true or false`);

    case "date": {
      if (typeof v !== "string") return bad("type", `${def.label} must be a YYYY-MM-DD string`);
      const m = v.match(DATE_RE);
      if (!m) return bad("format", `${def.label} must be YYYY-MM-DD`);
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      const valid = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
      return valid ? null : bad("format", `${def.label} is not a real calendar date`);
    }

    case "datetime": {
      if (typeof v !== "string") return bad("type", `${def.label} must be an ISO-8601 string`);
      // Require a date part plus a time part; Date.parse alone accepts too much.
      const ok = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
      return ok ? null : bad("format", `${def.label} must be an ISO-8601 date-time`);
    }

    case "picklist": {
      if (typeof v !== "string") return bad("type", `${def.label} must be one option`);
      const allowed = optionValues(def.options);
      return allowed.includes(v)
        ? null
        : bad("picklist", `${def.label}: "${v}" is not one of ${allowed.map((o) => `"${o}"`).join(", ")}`);
    }

    case "multipicklist": {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        return bad("type", `${def.label} must be an array of options`);
      }
      const allowed = optionValues(def.options);
      const rejected = (v as string[]).filter((x) => !allowed.includes(x));
      return rejected.length === 0
        ? null
        : bad("picklist", `${def.label}: ${rejected.map((o) => `"${o}"`).join(", ")} not in ${allowed.map((o) => `"${o}"`).join(", ")}`);
    }

    case "url": {
      if (typeof v !== "string") return bad("type", `${def.label} must be a URL string`);
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:" ? null : bad("format", `${def.label} must be an http(s) URL`);
      } catch {
        return bad("format", `${def.label} must be a valid URL`);
      }
    }

    case "phone": {
      if (typeof v !== "string") return bad("type", `${def.label} must be a phone string`);
      const digits = v.replace(/\D/g, "").length;
      return PHONE_RE.test(v.trim()) && digits >= 7 && digits <= 15 ? null : bad("format", `${def.label} must be a phone number`);
    }

    case "email":
      return typeof v === "string" && EMAIL_RE.test(v.trim()) ? null : bad("format", `${def.label} must be an email address`);

    case "lookup":
      return isUuid(v) ? null : bad("lookup", `${def.label} must be the id (uuid) of a ${lookupEntity(def.options) ?? "record"}`);

    default:
      return bad("type", `${def.label}: unsupported field type "${String(def.type)}"`);
  }
}

/** Normalise picklist options (strings or {value,label}) to their wire values. */
export function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const o of options as PicklistOption[]) {
    if (typeof o === "string") out.push(o);
    else if (o && typeof o === "object" && typeof o.value === "string") out.push(o.value);
  }
  return out;
}

function lookupEntity(options: unknown): string | null {
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const e = (options as { entity?: unknown }).entity;
    return typeof e === "string" ? e : null;
  }
  return null;
}
