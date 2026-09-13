//==============================================================================
// scripts/import-kv.ts — one-time loader: legacy Cloudflare KV (WO_KV) → Postgres.
//
// Run on Craig's machine (needs `wrangler login` for the live read):
//
//   # 1. Snapshot every KV key (+ the WO list from the live Worker, for WO refs)
//   npx tsx scripts/import-kv.ts --dump --out kv-dump.json --worker-url https://<worker>.workers.dev
//
//   # 2. Preview what the load would do (nothing is written)
//   DATABASE_URL=postgres://... npx tsx scripts/import-kv.ts --from-dump kv-dump.json --dry-run
//
//   # 3. Load. Re-runs are safe: every object upserts by its natural key.
//   DATABASE_URL=postgres://... npx tsx scripts/import-kv.ts --from-dump kv-dump.json
//
//   # (or read KV and load in one go)
//   DATABASE_URL=postgres://... npx tsx scripts/import-kv.ts --worker-url https://<worker>.workers.dev
//
// Env:  DATABASE_URL       direct/pooler postgres:// URL (as genesis_api or postgres) — load only
//       TENANT_ID          default f4100000-0000-4000-8000-000000000001 (FHI)
//       LEGACY_WO_KV_ID    KV namespace id (default aaeba18d5652455496657aa231210af4)
//       GENESIS_API_URL    default for --worker-url (GET /work-orders gives WO number/project/subject)
//       CREDS_KEY          base64 32-byte key; when set, /setup credentials are re-encrypted into
//                          integration_credentials (otherwise they are reported as skipped)
//
// The live KV is READ ONLY here: this script never writes to KV.
// Every write goes through the same repo primitives the Worker uses (withTenant +
// events rows, actor system:migration). Missing status_vocab pick-list values are
// auto-created (Craig's rule for importers).
//==============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { Env } from "../src/types";
import { withTenant, type Sql, type Tx } from "../src/db";
import { appendEvent } from "../src/events";
import { setSetting } from "../src/settings";
import { ensureVocab, ensureWorkOrderRef, linkExternalId, type WoRef } from "../src/repo/_shared";
import {
  TECHNICIAN_ROLE,
  addTechnicianTx,
  listTechniciansTx,
  updateTechnicianTx,
  type Technician,
} from "../src/repo/technicians";
import { getPeopleTx, savePersonTx, updatePersonTx, PersonError, type Person } from "../src/repo/people";
import { upsertHoursEntryAtTx } from "../src/repo/hours";
import { ensureDayTx, markSentTx, upsertEntryAtTx, pdfUrlFor, CUMULATIVE } from "../src/repo/daily-reports";
import { setReminderTx, type Reminder } from "../src/reminders";
import { saveAdminConfigTx } from "../src/admin";
import { writeCredentialTx } from "../src/creds";

export const DEFAULT_NAMESPACE_ID = "aaeba18d5652455496657aa231210af4";
export const DEFAULT_TENANT_ID = "f4100000-0000-4000-8000-000000000001";
export const IMPORT_ACTOR = "system:migration";

//------------------------------------------------------------------------------
// Dump format
//------------------------------------------------------------------------------

/** What GET /work-orders (LIST shape) tells us about a WO — enough for a shadow row. */
export interface DumpWorkOrder {
  workOrderNumber: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  client?: string | null;
  subject: string;
}

export interface KvDump {
  version: 1;
  namespaceId: string;
  dumpedAt: string;
  /** Raw KV values, keyed by KV key name. */
  keys: Record<string, string>;
  /** Keyed by Zoho Action task id (= WorkOrder.id). Optional; without it hours/daily rows land under placeholder WOs. */
  workOrders?: Record<string, DumpWorkOrder>;
}

//------------------------------------------------------------------------------
// Reading KV through wrangler (never writes)
//------------------------------------------------------------------------------

function wrangler(args: string[]): string {
  // shell:true so `npx` resolves on Windows (npx.cmd) as well as POSIX.
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: true, stdio: ["ignore", "pipe", "inherit"] });
}

export function readKvViaWrangler(namespaceId: string, log: (s: string) => void = console.error): Record<string, string> {
  log(`Listing keys in KV namespace ${namespaceId} …`);
  const listed = JSON.parse(wrangler(["kv", "key", "list", `--namespace-id=${namespaceId}`])) as Array<{ name: string }>;
  const out: Record<string, string> = {};
  let n = 0;
  for (const k of listed) {
    out[k.name] = wrangler(["kv", "key", "get", k.name, `--namespace-id=${namespaceId}`, "--text"]);
    n++;
    if (n % 25 === 0) log(`  … ${n}/${listed.length}`);
  }
  log(`Read ${n} keys.`);
  return out;
}

export async function fetchWorkOrders(workerUrl: string): Promise<Record<string, DumpWorkOrder>> {
  const base = workerUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/work-orders`);
  if (!res.ok) throw new Error(`GET ${base}/work-orders → HTTP ${res.status}`);
  const body = (await res.json()) as { workOrders?: Array<Record<string, unknown>> };
  const out: Record<string, DumpWorkOrder> = {};
  for (const wo of body.workOrders ?? []) {
    const id = String(wo.id ?? "");
    if (!id) continue;
    out[id] = {
      workOrderNumber: String(wo.workOrderNumber ?? ""),
      projectId: String(wo.projectId ?? ""),
      projectKey: String(wo.projectKey ?? ""),
      projectName: String(wo.projectName ?? ""),
      client: typeof wo.client === "string" ? wo.client : null,
      subject: String(wo.subject ?? ""),
    };
  }
  return out;
}

//------------------------------------------------------------------------------
// Key classification — the full WO_KV inventory (see F3-NOTES.md)
//------------------------------------------------------------------------------

export type KeyKind =
  | "technicians" | "people" | "admin_config"
  | "hours" | "billable"
  | "dailyreport_entries" | "dailyreport_days" | "dailyreport_sent" | "dailyreport_pdf"
  | "reminder" | "wo_seq"
  | "zoho_creds" | "google_creds" | "zoho_scopes" | "google_pending"
  | "cache" | "unknown";

export function classifyKey(name: string): { kind: KeyKind; parts: string[] } {
  if (name === "technicians") return { kind: "technicians", parts: [] };
  if (name === "people") return { kind: "people", parts: [] };
  if (name === "admin:config") return { kind: "admin_config", parts: [] };
  if (name === "zoho_creds") return { kind: "zoho_creds", parts: [] };
  if (name === "google_creds") return { kind: "google_creds", parts: [] };
  if (name === "zoho_scopes") return { kind: "zoho_scopes", parts: [] };
  if (name === "google_pending") return { kind: "google_pending", parts: [] };
  let m: RegExpMatchArray | null;
  if ((m = name.match(/^hours:(.+)$/))) return { kind: "hours", parts: [m[1]] };
  if ((m = name.match(/^billable:(.+)$/))) return { kind: "billable", parts: [m[1]] };
  if ((m = name.match(/^dailyreport:([^:]+):(.+)$/))) return { kind: "dailyreport_entries", parts: [m[1], m[2]] };
  if ((m = name.match(/^dailyreport-days:(.+)$/))) return { kind: "dailyreport_days", parts: [m[1]] };
  if ((m = name.match(/^dailyreport-sent:([^:]+):(.+)$/))) return { kind: "dailyreport_sent", parts: [m[1], m[2]] };
  if ((m = name.match(/^dailyreport-pdf:([^:]+):(.+)$/))) return { kind: "dailyreport_pdf", parts: [m[1], m[2]] };
  if ((m = name.match(/^reminder:(.+)$/))) return { kind: "reminder", parts: [m[1]] };
  if ((m = name.match(/^wo_seq:(\d{4}):(.+)$/))) return { kind: "wo_seq", parts: [m[1], m[2]] };
  if (/^(proj:|tasks:|ai:agg:|wo:)/.test(name)) return { kind: "cache", parts: [] };
  return { kind: "unknown", parts: [] };
}

//------------------------------------------------------------------------------
// Summary
//------------------------------------------------------------------------------

export interface Counter { created: number; updated: number; unchanged: number; skipped: number; errors: number; }
export interface ImportSummary {
  dryRun: boolean;
  keysSeen: number;
  objects: Record<string, Counter>;
  /** sequences rows written: `${kind}/${scope}/${year}` → next */
  sequences: Record<string, number>;
  notes: string[];
  errors: string[];
  unknownKeys: string[];
}

function counter(s: ImportSummary, name: string): Counter {
  return (s.objects[name] ??= { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 });
}

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Insert keeping the legacy KV uuid as the row id (so ids the app already holds stay
 * valid). users.id is a global primary key, so if that uuid is somehow taken (another
 * tenant, a previous partial load) the insert is retried with a fresh id inside a
 * savepoint and the fact is noted — never a failed import.
 */
async function withLegacyId<T>(
  tx: Tx,
  legacyId: string,
  s: ImportSummary,
  label: string,
  run: (sp: Tx, id: string | undefined) => Promise<T>
): Promise<T> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(legacyId);
  // The driver types savepoint() as UnwrapPromiseArray<T>; our callback returns one awaited T.
  const sp = (id: string | undefined) => tx.savepoint((inner) => run(inner as unknown as Tx, id)) as Promise<T>;
  if (!isUuid) return sp(undefined);
  try {
    return await sp(legacyId);
  } catch (e) {
    const code = (e as { code?: string }).code;
    const constraint = (e as { constraint_name?: string }).constraint_name;
    if (code === "23505" && constraint === "users_pkey") {
      s.notes.push(`${label}: legacy id ${legacyId} already in use — a new id was assigned`);
      return sp(undefined);
    }
    throw e;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64.trim(), "base64"));
}

//------------------------------------------------------------------------------
// The load
//------------------------------------------------------------------------------

export interface ImportOptions {
  env: Env;
  tenantId?: string;
  dryRun?: boolean;
  /** Reuse a client (tests). */
  sql?: Sql;
  log?: (s: string) => void;
}

class DryRunRollback extends Error {}

export async function importDump(dump: KvDump, opts: ImportOptions): Promise<ImportSummary> {
  const tenantId = opts.tenantId ?? opts.env.TENANT_ID ?? DEFAULT_TENANT_ID;
  const env: Env = { ...opts.env, TENANT_ID: tenantId };
  const summary: ImportSummary = { dryRun: !!opts.dryRun, keysSeen: Object.keys(dump.keys).length, objects: {}, sequences: {}, notes: [], errors: [], unknownKeys: [] };
  const log = opts.log ?? (() => undefined);

  try {
    await withTenant(
      env,
      tenantId,
      async (tx) => {
        await loadAll(tx, env, dump, summary, log);
        if (opts.dryRun) throw new DryRunRollback("dry run");
      },
      { sql: opts.sql }
    );
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
    summary.notes.push("dry run: transaction rolled back, nothing written");
  }
  return summary;
}

function woRefFor(dump: KvDump, actionTaskId: string): WoRef {
  const w = dump.workOrders?.[actionTaskId];
  return {
    actionTaskId,
    zohoProjectId: w?.projectId ?? "",
    projectKey: w?.projectKey ?? "",
    projectName: w?.projectName ?? "",
    client: w?.client ?? null,
    workOrderNumber: w?.workOrderNumber ?? "",
    subject: w?.subject ?? "",
  };
}

async function loadAll(tx: Tx, env: Env, dump: KvDump, s: ImportSummary, log: (m: string) => void): Promise<void> {
  const keys = dump.keys;
  const by: Record<KeyKind, Array<{ name: string; parts: string[] }>> = {
    technicians: [], people: [], admin_config: [], hours: [], billable: [],
    dailyreport_entries: [], dailyreport_days: [], dailyreport_sent: [], dailyreport_pdf: [],
    reminder: [], wo_seq: [], zoho_creds: [], google_creds: [], zoho_scopes: [], google_pending: [],
    cache: [], unknown: [],
  };
  for (const name of Object.keys(keys)) {
    const c = classifyKey(name);
    by[c.kind].push({ name, parts: c.parts });
  }
  const unresolved = new Set<string>();
  const noteUnresolved = (id: string) => {
    if (!dump.workOrders?.[id]) unresolved.add(id);
  };

  // Pick-list values this loader needs (auto-create — Craig's importer rule).
  if (await ensureVocab(tx, "user_role", TECHNICIAN_ROLE, "Technician")) s.notes.push(`status_vocab user_role/${TECHNICIAN_ROLE} created`);

  // --- technicians ------------------------------------------------------------
  {
    const c = counter(s, "technicians");
    const list = parseJson<Technician[]>(keys["technicians"]) ?? [];
    const existing = await listTechniciansTx(tx);
    const byEmail = new Map(existing.map((t) => [t.email.toLowerCase(), t]));
    for (const t of list) {
      try {
        const email = String(t.email ?? "").trim().toLowerCase();
        const name = String(t.name ?? "").trim();
        const have = byEmail.get(email);
        if (have) {
          if (have.name === name && have.active === !!t.active) c.unchanged++;
          else {
            await updateTechnicianTx(tx, have.id, { name, active: !!t.active }, { actor: IMPORT_ACTOR });
            c.updated++;
          }
          await linkExternalId(tx, "user", have.id, "legacy_kv_technician", String(t.id));
        } else {
          const r = await withLegacyId(tx, String(t.id), s, `technician ${email}`, (sp, id) =>
            addTechnicianTx(sp, { name, email }, { id, actor: IMPORT_ACTOR, idempotencyKey: `import-kv:technician:${email}` })
          );
          if (!t.active) await updateTechnicianTx(tx, r.technician.id, { active: false }, { actor: IMPORT_ACTOR });
          await linkExternalId(tx, "user", r.technician.id, "legacy_kv_technician", String(t.id));
          byEmail.set(email, r.technician);
          r.created ? c.created++ : c.updated++;
        }
      } catch (e) {
        c.errors++;
        s.errors.push(`technician ${t?.email}: ${(e as Error).message}`);
      }
    }
    log(`technicians: ${JSON.stringify(c)}`);
  }

  // --- people -------------------------------------------------------------------
  {
    const c = counter(s, "people");
    const list = parseJson<Person[]>(keys["people"]) ?? [];
    const existing = await getPeopleTx(tx);
    const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p]));
    for (const p of list) {
      try {
        const name = String(p.name ?? "").trim();
        const email = String(p.email ?? "").trim().toLowerCase();
        const zohoUser = (p.zohoUser ?? "").trim() || null;
        const have = byName.get(name.toLowerCase());
        if (have) {
          const same = have.email === email && have.active === !!p.active && (have.zohoUser ?? null) === zohoUser;
          if (same) c.unchanged++;
          else {
            await updatePersonTx(tx, have.id, { email, active: !!p.active, zohoUser }, { actor: IMPORT_ACTOR });
            c.updated++;
          }
          await linkExternalId(tx, "user", have.id, "legacy_kv_person", String(p.id));
          continue;
        }
        try {
          const created = await withLegacyId(tx, String(p.id), s, `person ${name}`, (sp, id) =>
            savePersonTx(sp, { name, email, zohoUser }, { id, actor: IMPORT_ACTOR, idempotencyKey: `import-kv:person:${name.toLowerCase()}` })
          );
          if (!p.active) await updatePersonTx(tx, created.id, { active: false }, { actor: IMPORT_ACTOR });
          await linkExternalId(tx, "user", created.id, "legacy_kv_person", String(p.id));
          byName.set(name.toLowerCase(), created);
          c.created++;
        } catch (e) {
          if (e instanceof PersonError && email) {
            // Same email as an existing user (a technician): ONE person in the unified model.
            const all = await getPeopleTx(tx);
            const byEmail = all.find((u) => u.email.toLowerCase() === email);
            if (byEmail) {
              if (zohoUser && byEmail.zohoUser !== zohoUser) await updatePersonTx(tx, byEmail.id, { zohoUser }, { actor: IMPORT_ACTOR });
              await linkExternalId(tx, "user", byEmail.id, "legacy_kv_person", String(p.id));
              s.notes.push(`person "${name}" merged into existing user ${byEmail.name} <${email}>`);
              c.updated++;
              continue;
            }
          }
          throw e;
        }
      } catch (e) {
        c.errors++;
        s.errors.push(`person ${p?.name}: ${(e as Error).message}`);
      }
    }
    log(`people: ${JSON.stringify(c)}`);
  }

  // --- hours ----------------------------------------------------------------------
  {
    const c = counter(s, "hours_entries");
    for (const { name, parts } of by.hours) {
      const actionTaskId = parts[0];
      const blob = parseJson<{ entries?: Array<{ tech?: string | null; hours?: number; at?: string; note?: string | null }> }>(keys[name]);
      if (!blob || !Array.isArray(blob.entries)) { c.skipped++; s.errors.push(`${name}: unparseable`); continue; }
      noteUnresolved(actionTaskId);
      const ref = woRefFor(dump, actionTaskId);
      for (let i = 0; i < blob.entries.length; i++) {
        const e = blob.entries[i];
        try {
          const r = await upsertHoursEntryAtTx(tx, ref, i, { tech: e.tech ?? null, hours: Number(e.hours ?? 0), at: e.at ?? null, note: e.note ?? null },
            { actor: IMPORT_ACTOR, idempotencyKey: `import-kv:hours:${actionTaskId}:${i}` });
          r.created ? c.created++ : c.updated++;
        } catch (err) {
          c.errors++;
          s.errors.push(`${name}[${i}]: ${(err as Error).message}`);
        }
      }
    }
    log(`hours_entries: ${JSON.stringify(c)}`);
  }

  // --- daily reports --------------------------------------------------------------
  {
    const days = counter(s, "daily_report_days");
    const ents = counter(s, "daily_report_entries");
    // Days index first (a day can exist with zero entries).
    for (const { name, parts } of by.dailyreport_days) {
      const actionTaskId = parts[0];
      const blob = parseJson<{ days?: string[] }>(keys[name]);
      if (!blob || !Array.isArray(blob.days)) { days.skipped++; s.errors.push(`${name}: unparseable`); continue; }
      noteUnresolved(actionTaskId);
      for (const d of blob.days) {
        try {
          (await ensureDayTx(tx, woRefFor(dump, actionTaskId), d)).created ? days.created++ : days.unchanged++;
        } catch (err) {
          days.errors++;
          s.errors.push(`${name} day ${d}: ${(err as Error).message}`);
        }
      }
    }
    for (const { name, parts } of by.dailyreport_entries) {
      const [actionTaskId, date] = parts;
      const blob = parseJson<{ entries?: Array<{ tech?: string | null; text?: string; at?: string }> }>(keys[name]);
      if (!blob || !Array.isArray(blob.entries)) { ents.skipped++; s.errors.push(`${name}: unparseable`); continue; }
      noteUnresolved(actionTaskId);
      const ref = woRefFor(dump, actionTaskId);
      try {
        (await ensureDayTx(tx, ref, date)).created && days.created++;
      } catch (err) {
        days.errors++;
        s.errors.push(`${name}: ${(err as Error).message}`);
        continue;
      }
      for (let i = 0; i < blob.entries.length; i++) {
        const e = blob.entries[i];
        try {
          const r = await upsertEntryAtTx(tx, ref, date, i, { text: String(e.text ?? ""), tech: e.tech ?? null, at: e.at ?? null },
            { actor: IMPORT_ACTOR, idempotencyKey: `import-kv:dr:${actionTaskId}:${date}:${i}` });
          r.created ? ents.created++ : ents.updated++;
        } catch (err) {
          ents.errors++;
          s.errors.push(`${name}[${i}]: ${(err as Error).message}`);
        }
      }
    }
    // Sent markers + PDFs → sent_at + files row.
    const sent = counter(s, "daily_report_sent");
    const pdfs = counter(s, "daily_report_pdfs");
    const pdfKeys = new Map(by.dailyreport_pdf.map((k) => [`${k.parts[0]}:${k.parts[1]}`, k.name]));
    const handled = new Set<string>();
    for (const { name, parts } of by.dailyreport_sent) {
      const [actionTaskId, date] = parts;
      const marker = parseJson<{ sent?: boolean; at?: string; pdfUrl?: string | null; woNumber?: string | null }>(keys[name]);
      if (!marker) { sent.skipped++; s.errors.push(`${name}: unparseable`); continue; }
      noteUnresolved(actionTaskId);
      const ref = woRefFor(dump, actionTaskId);
      if (!ref.workOrderNumber && marker.woNumber) ref.workOrderNumber = marker.woNumber;
      const pdfKey = pdfKeys.get(`${actionTaskId}:${date}`);
      const pdf = pdfKey ? base64ToBytes(keys[pdfKey]) : null;
      handled.add(`${actionTaskId}:${date}`);
      try {
        if (marker.sent === true) {
          await markSentTx(tx, ref, date, pdf, { sentAt: marker.at ?? null, pdfUrl: marker.pdfUrl ?? pdfUrlFor(env, actionTaskId, date), actor: IMPORT_ACTOR, idempotencyKey: `import-kv:sent:${actionTaskId}:${date}` });
          sent.created++;
          if (pdf) pdfs.created++;
        } else sent.skipped++;
      } catch (err) {
        sent.errors++;
        s.errors.push(`${name}: ${(err as Error).message}`);
      }
    }
    for (const { name, parts } of by.dailyreport_pdf) {
      const [actionTaskId, date] = parts;
      if (handled.has(`${actionTaskId}:${date}`)) continue;
      // A PDF without a sent marker only happens if a send was interrupted; store it as sent.
      noteUnresolved(actionTaskId);
      try {
        await markSentTx(tx, woRefFor(dump, actionTaskId), date === CUMULATIVE ? CUMULATIVE : date, base64ToBytes(keys[name]), { actor: IMPORT_ACTOR, idempotencyKey: `import-kv:pdf:${actionTaskId}:${date}` });
        pdfs.created++;
        s.notes.push(`${name}: PDF had no sent marker — stored and marked sent`);
      } catch (err) {
        pdfs.errors++;
        s.errors.push(`${name}: ${(err as Error).message}`);
      }
    }
    log(`daily reports: days ${JSON.stringify(days)} entries ${JSON.stringify(ents)} sent ${JSON.stringify(sent)} pdfs ${JSON.stringify(pdfs)}`);
  }

  // --- reminders --------------------------------------------------------------------
  {
    const c = counter(s, "reminders");
    for (const { name, parts } of by.reminder) {
      const issueId = parts[0];
      const r = parseJson<Reminder>(keys[name]);
      if (!r || !r.remindAt) { c.skipped++; s.errors.push(`${name}: unparseable`); continue; }
      try {
        await setReminderTx(tx, issueId, { projectId: r.projectId ?? "", projectName: r.projectName ?? null, title: r.title ?? null, assigneeName: r.assigneeName ?? null, remindAt: r.remindAt, message: r.message ?? null },
          { actor: IMPORT_ACTOR, idempotencyKey: `import-kv:reminder:${issueId}`, createdAt: r.createdAt ?? null, fired: r.fired === true });
        c.created++;
      } catch (err) {
        c.errors++;
        s.errors.push(`${name}: ${(err as Error).message}`);
      }
    }
    log(`reminders: ${JSON.stringify(c)}`);
  }

  // --- admin config -----------------------------------------------------------------
  {
    const c = counter(s, "admin_config");
    if (keys["admin:config"] !== undefined) {
      const cfg = parseJson<Record<string, unknown>>(keys["admin:config"]);
      if (!cfg) { c.skipped++; s.errors.push("admin:config: unparseable"); }
      else {
        try {
          await saveAdminConfigTx(tx, cfg as never, { actor: IMPORT_ACTOR, idempotencyKey: "import-kv:admin:config" });
          c.updated++;
        } catch (err) {
          c.errors++;
          s.errors.push(`admin:config: ${(err as Error).message}`);
        }
      }
    }
  }

  // --- /setup credentials + scopes ----------------------------------------------------
  {
    const c = counter(s, "credentials");
    const haveKey = !!(env.CREDS_KEY ?? "").trim();
    for (const [kvKey, system] of [["zoho_creds", "zoho"], ["google_creds", "google"]] as const) {
      if (keys[kvKey] === undefined) continue;
      const v = parseJson<Record<string, string>>(keys[kvKey]);
      if (!v) { c.skipped++; s.errors.push(`${kvKey}: unparseable`); continue; }
      if (!haveKey) { c.skipped++; s.notes.push(`${kvKey}: CREDS_KEY not set — not imported (set the secret and re-run, or re-enter on /setup)`); continue; }
      try {
        await writeCredentialTx(tx, env, system, v, { actor: IMPORT_ACTOR, idempotencyKey: `import-kv:creds:${system}` });
        c.updated++;
      } catch (err) {
        c.errors++;
        s.errors.push(`${kvKey}: ${(err as Error).message}`);
      }
    }
    if (keys["zoho_scopes"] !== undefined) {
      await setSetting(tx, "zoho.setup_scopes", keys["zoho_scopes"]);
      counter(s, "zoho_scopes").updated++;
    }
    if (keys["google_pending"] !== undefined) {
      counter(s, "google_pending").skipped++;
      s.notes.push("google_pending: transient (15-minute OAuth handshake state) — not imported");
    }
  }

  // --- WO sequence counter ---------------------------------------------------------
  {
    const c = counter(s, "wo_seq");
    for (const { name, parts } of by.wo_seq) {
      const year = Number(parts[0]);
      // KV spelled the portal-wide scope `__global__`; the DB's mint function uses `global`.
      const scope = parts[1] === "__global__" ? "global" : parts[1];
      const current = parseInt(keys[name] ?? "", 10);
      if (!Number.isFinite(current)) { c.skipped++; s.errors.push(`${name}: not a number`); continue; }
      const next = current + 1;
      try {
        const rows = await tx<{ next: number }[]>`
          insert into public.sequences as q (tenant_id, kind, scope_key, year, next)
          values (public.app_tenant_id(), 'work_order', ${scope}, ${year}, ${next})
          on conflict (tenant_id, kind, scope_key, year)
          do update set next = greatest(q.next, excluded.next), updated_at = now()
          returning q.next`;
        s.sequences[`work_order/${scope}/${year}`] = Number(rows[0].next);
        if (Number(rows[0].next) !== next) s.notes.push(`${name}: sequences.next already ${rows[0].next} (> ${next}); kept the higher value`);
        c.updated++;
        await appendEvent(tx, { entity: "sequence", entityId: null, eventType: "sequence.primed", payload: { kind: "work_order", scope, year, kvValue: current, next: Number(rows[0].next) }, actor: IMPORT_ACTOR, idempotencyKey: `import-kv:wo_seq:${year}:${scope}:${current}` });
      } catch (err) {
        c.errors++;
        s.errors.push(`${name}: ${(err as Error).message}`);
      }
    }
    log(`wo_seq: ${JSON.stringify(c)} ${JSON.stringify(s.sequences)}`);
  }

  // --- legacy billable flags (retired 2026-09-09) → preserved as events ----------------
  {
    const c = counter(s, "legacy_billable");
    for (const { name, parts } of by.billable) {
      const actionTaskId = parts[0];
      const raw = (keys[name] ?? "").trim();
      const billable = !(raw === "false" || raw === "0");
      if (billable) { c.skipped++; continue; } // default value — carries no information
      noteUnresolved(actionTaskId);
      try {
        const woId = await ensureWorkOrderRef(tx, woRefFor(dump, actionTaskId));
        await appendEvent(tx, { entity: "work_order", entityId: woId, eventType: "work_order.legacy_billable", payload: { actionTaskId, billable: false, source: name }, actor: IMPORT_ACTOR, idempotencyKey: `import-kv:${name}` });
        c.created++;
      } catch (err) {
        c.errors++;
        s.errors.push(`${name}: ${(err as Error).message}`);
      }
    }
  }

  // --- ephemeral / unknown ---------------------------------------------------------
  counter(s, "cache_keys").skipped += by.cache.length;
  for (const { name } of by.unknown) s.unknownKeys.push(name);
  if (by.unknown.length) counter(s, "unknown_keys").skipped += by.unknown.length;
  if (unresolved.size) s.notes.push(`${unresolved.size} WO id(s) had no entry in dump.workOrders — their rows sit under placeholder WOs (public_key ZOHO-T-<id>, project ${"F3-UNMAPPED"}); re-dump with --worker-url to resolve: ${[...unresolved].slice(0, 10).join(", ")}${unresolved.size > 10 ? ", …" : ""}`);
}

//------------------------------------------------------------------------------
// CLI
//------------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(name);

export function printSummary(s: ImportSummary): void {
  const rows = Object.entries(s.objects).map(([object, c]) => ({ object, ...c }));
  console.log(`\n${s.dryRun ? "DRY RUN — " : ""}${s.keysSeen} KV keys seen`);
  console.table(rows);
  if (Object.keys(s.sequences).length) console.log("sequences:", s.sequences);
  for (const n of s.notes) console.log("note:", n);
  for (const u of s.unknownKeys) console.log("unknown key (not imported):", u);
  for (const e of s.errors) console.log("ERROR:", e);
}

async function main(): Promise<void> {
  const namespaceId = arg("--namespace-id") ?? process.env.LEGACY_WO_KV_ID ?? DEFAULT_NAMESPACE_ID;
  const workerUrl = arg("--worker-url") ?? process.env.GENESIS_API_URL;
  const fromDump = arg("--from-dump");
  const out = arg("--out") ?? "kv-dump.json";

  let dump: KvDump;
  if (fromDump) {
    dump = JSON.parse(readFileSync(fromDump, "utf8")) as KvDump;
    console.error(`Loaded ${Object.keys(dump.keys).length} keys from ${fromDump} (dumped ${dump.dumpedAt}).`);
  } else {
    dump = { version: 1, namespaceId, dumpedAt: new Date().toISOString(), keys: readKvViaWrangler(namespaceId) };
    if (workerUrl) {
      dump.workOrders = await fetchWorkOrders(workerUrl);
      console.error(`Fetched ${Object.keys(dump.workOrders).length} work orders from ${workerUrl}.`);
    } else {
      console.error("WARNING: no --worker-url / GENESIS_API_URL — hours/daily rows will land under placeholder WOs.");
    }
    if (has("--dump")) {
      writeFileSync(out, JSON.stringify(dump, null, 2));
      console.error(`Wrote ${out}.`);
      return;
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to load (use --dump to only snapshot KV).");
  const env = {
    DATABASE_URL: databaseUrl,
    TENANT_ID: process.env.TENANT_ID ?? DEFAULT_TENANT_ID,
    CREDS_KEY: process.env.CREDS_KEY,
    PUBLIC_WORKER_URL: process.env.PUBLIC_WORKER_URL,
  } as unknown as Env;
  const summary = await importDump(dump, { env, dryRun: has("--dry-run"), log: (m) => console.error(m) });
  printSummary(summary);
  if (summary.errors.length) process.exitCode = 1;
}

// Run only when invoked directly (tests import the functions).
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/import-kv.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
