// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09 — walk review link (spec §5.8, Decision 7): export · GET /walk/:token (HTML) · reply · add-only pull
//==============================================================================
// sync/walk-review.ts — the walk review link (spec §5.8; §6 check 9).
//
//   POST /walks/:id/export {expires_in_days? = 30}
//        designer / office / admin, or the walk's creator. Builds a JSON SNAPSHOT of the walk —
//        rooms (walk order = first capture in the room) → entries: location_notes, location_media
//        (file ids; `internal` media never leaves the org view — excluded), as-walked
//        device_placements — plus the walk-sketch pages (drawings.pages with walk_id = this walk,
//        with preview_file_id; Amendment 2). Stored INLINE in walk_exports.snapshot (056) so the
//        page needs no R2 round-trip; snapshot_file_id stays NULL. share_token = 32 random bytes,
//        base64url (43 chars; 045 CHECK ≥ 32). → 201 {export_id, share_token, url, expires_at}.
//   GET  /walk/:token
//        LOGIN-GATED: the caller is an authenticated member of the export's Organization (the
//        org-context 401/403s everyone else; a token of another org is simply not found → 404);
//        expired / revoked → 410. Renders text/html (self-contained, no external scripts): one
//        card per room, collapsed by default, print-friendly; each entry shows its id, body, the
//        latest reply + author, and a reply box; sketch previews as <img src="/files/<id>">
//        (GET /files/:id, added by W5 in files.ts, streams the bytes from R2).
//   POST /walk/:token/reply {entry_id, entry_table?, reply?, checked?, replied_by?}
//        same gate → ONE walk_replies row (entry_table from the snapshot when omitted; replied_by
//        defaults to the member's display name / email). reply or checked required (045 CHECK).
//        → 201 {reply_id}. The entry_id is taken AS SENT — a typo'd id is still stored and becomes
//        an action item at pull time (check 9).
//   POST /walks/:id/pull-replies
//        ADD-ONLY merge, idempotent: every unmerged reply on this walk's exports →
//          matched  (entry_id is a LIVE location_notes / location_media / device_placements row
//                    of THIS walk) → INSERT location_notes(kind='reply', body = reply, same room /
//                    location / project / walk, note_layer 'office', custom.checked when sent);
//                    the ORIGINAL row is never updated — app text is never overwritten;
//          unmatched → event walk_reply.unmatched + the field_rules engine (060 seed:
//                    walk_reply.unmatched → action_items(source_kind='walk_reply'), idempotent on
//                    (org, source_kind, source_ref_id = the reply id)).
//        Each reply is stamped merged_at / merge_outcome (+ merged_note_id). Re-run → {0, 0, n}.
//        ONE event walk.replies_pulled. → 200 {merged, unmatched, skipped}.
//
// Every statement goes through withOrg / withOrgRead and filters organization_id too.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg, withOrgRead } from "../org-context";
import { isUuid } from "../db";
import { evaluateRules } from "../rules";
import { emitEvent, type RouteResult } from "./checkout";
import { isOfficeOrAdmin } from "./drawings";
import type { JsonRow } from "./tables";

export const DEFAULT_EXPIRES_DAYS = 30;
export const MAX_EXPIRES_DAYS = 365;
export const ENTRY_TABLES = ["places.location_notes", "places.location_media", "places.device_placements"] as const;
export type EntryTable = (typeof ENTRY_TABLES)[number];

/** A response the router serialises verbatim (HTML), not as JSON. */
export interface HtmlResult {
  status: number;
  body: string;
  contentType: string;
}

interface WalkRow {
  id: string;
  project_id: string | null;
  account_id: string | null;
  status: string;
  label: string | null;
  address_hint: string | null;
  started_at: Date;
  ended_at: Date | null;
  created_by: string;
  deleted_at: Date | null;
  device_id: string | null;
}

function mayManageWalk(ctx: OrganizationContext, walk: { created_by: string }): boolean {
  return isOfficeOrAdmin(ctx) || ctx.role === "designer" || walk.created_by === ctx.actorId;
}

/** 32 random bytes → base64url (43 chars, no padding). Exported for tests. */
export function mintShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

//------------------------------------------------------------------------------
// Snapshot
//------------------------------------------------------------------------------

export interface SnapshotEntry {
  id: string;
  table: EntryTable;
  kind: string;
  text: string | null;
  phase: string | null;
  location: string | null;
  file_id: string | null;
  file_status: string | null;
  content_type: string | null;
  occurred_at: string;
  by: string | null;
  extra: JsonRow;
}
export interface SnapshotSketch { page_id: string; drawing_id: string; name: string | null; preview_file_id: string | null; preview_status: string | null; ordinal: number }
export interface SnapshotRoom { key: string; room_id: string | null; name: string; first_at: string | null; entries: SnapshotEntry[]; sketches: SnapshotSketch[] }
export interface WalkSnapshot {
  version: 1;
  walk: { id: string; label: string | null; status: string; project_id: string | null; project_name: string | null; account_name: string | null; address_hint: string | null; started_at: string; ended_at: string | null; created_by: string; created_by_name: string | null };
  exported_at: string;
  exported_by: { id: string; name: string | null };
  rooms: SnapshotRoom[];
  counts: { rooms: number; notes: number; media: number; placements: number; sketches: number };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

export async function buildWalkSnapshot(tx: Tx, ctx: OrganizationContext, walk: WalkRow): Promise<WalkSnapshot> {
  const org = ctx.organizationId;
  const members = new Map<string, string>();
  for (const m of await tx<{ id: string; display_name: string; email: string | null }[]>`select id, display_name, email from shared.members where organization_id = ${org}`) {
    members.set(m.id, m.display_name || m.email || m.id);
  }
  const rooms = new Map<string, { id: string; name: string; sort_order: number | null }>();
  for (const r of await tx<{ id: string; name: string; sort_order: number | null }[]>`select id, name, sort_order from places.rooms where organization_id = ${org} and deleted_at is null`) rooms.set(r.id, r);
  const locations = new Map<string, string>();
  for (const l of await tx<{ id: string; label: string }[]>`select id, label from places.locations where organization_id = ${org} and deleted_at is null`) locations.set(l.id, l.label);

  const notes = await tx<JsonRow[]>`
    select id, room_id, room_hint, location_id, location_hint, kind, phase, note_layer, body, custom, occurred_at, created_by
      from places.location_notes where walk_id = ${walk.id} and organization_id = ${org} and deleted_at is null order by occurred_at, id`;
  const media = await tx<JsonRow[]>`
    select m.id, m.room_id, m.room_hint, m.location_id, m.location_hint, m.file_id, m.phase, m.caption, m.custom, m.occurred_at, m.created_by,
           f.upload_status, f.content_type, f.filename
      from places.location_media m left join shared.files f on f.id = m.file_id and f.organization_id = m.organization_id
     where m.walk_id = ${walk.id} and m.organization_id = ${org} and m.deleted_at is null and m.internal = false and m.archived_at is null
     order by m.occurred_at, m.id`;
  const placements = await tx<JsonRow[]>`
    select id, room_id, room_hint, location_id, location_hint, product_name, product_sku, placement_status, phase, custom, occurred_at, created_by
      from places.device_placements where walk_id = ${walk.id} and organization_id = ${org} and deleted_at is null and capture_kind = 'as_walked' order by occurred_at, id`;
  const sketches = await tx<JsonRow[]>`
    select p.id, p.drawing_id, p.room_id, p.room_hint, p.name, p.ordinal, p.preview_file_id, p.occurred_at, f.upload_status
      from drawings.pages p left join shared.files f on f.id = p.preview_file_id and f.organization_id = p.organization_id
     where p.walk_id = ${walk.id} and p.organization_id = ${org} and p.deleted_at is null order by p.ordinal, p.id`;

  const groups = new Map<string, SnapshotRoom>();
  const groupFor = (r: JsonRow): SnapshotRoom => {
    const roomId = (r.room_id as string | null) ?? null;
    const hint = typeof r.room_hint === "string" && r.room_hint.trim() ? r.room_hint.trim() : null;
    const key = roomId ? `room:${roomId}` : hint ? `hint:${hint.toLowerCase().replace(/\s+/g, " ")}` : "unassigned";
    let g = groups.get(key);
    if (!g) {
      g = { key, room_id: roomId, name: roomId ? rooms.get(roomId)?.name ?? hint ?? "Room" : hint ?? "Unassigned", first_at: null, entries: [], sketches: [] };
      groups.set(key, g);
    }
    const at = iso(r.occurred_at);
    if (at && (!g.first_at || at < g.first_at)) g.first_at = at;
    return g;
  };
  const loc = (r: JsonRow) => (r.location_id ? locations.get(r.location_id as string) ?? null : null) ?? (typeof r.location_hint === "string" ? r.location_hint : null);
  for (const n of notes) {
    groupFor(n).entries.push({ id: n.id as string, table: "places.location_notes", kind: String(n.kind), text: String(n.body ?? ""), phase: (n.phase as string | null) ?? null, location: loc(n),
      file_id: null, file_status: null, content_type: null, occurred_at: iso(n.occurred_at)!, by: members.get(n.created_by as string) ?? null, extra: { note_layer: n.note_layer, custom: n.custom } });
  }
  for (const m of media) {
    groupFor(m).entries.push({ id: m.id as string, table: "places.location_media", kind: "photo", text: (m.caption as string | null) ?? null, phase: (m.phase as string | null) ?? null, location: loc(m),
      file_id: (m.file_id as string | null) ?? null, file_status: (m.upload_status as string | null) ?? null, content_type: (m.content_type as string | null) ?? null, occurred_at: iso(m.occurred_at)!,
      by: members.get(m.created_by as string) ?? null, extra: { filename: m.filename ?? null, custom: m.custom } });
  }
  for (const p of placements) {
    groupFor(p).entries.push({ id: p.id as string, table: "places.device_placements", kind: "as_walked", text: String(p.product_name ?? ""), phase: (p.phase as string | null) ?? null, location: loc(p),
      file_id: null, file_status: null, content_type: null, occurred_at: iso(p.occurred_at)!, by: members.get(p.created_by as string) ?? null,
      extra: { product_sku: p.product_sku ?? null, placement_status: p.placement_status, custom: p.custom } });
  }
  for (const s of sketches) {
    groupFor(s).sketches.push({ page_id: s.id as string, drawing_id: s.drawing_id as string, name: (s.name as string | null) ?? null, preview_file_id: (s.preview_file_id as string | null) ?? null,
      preview_status: (s.upload_status as string | null) ?? null, ordinal: Number(s.ordinal) });
  }
  for (const g of groups.values()) g.entries.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key === "unassigned") return 1;
    if (b.key === "unassigned") return -1;
    return (a.first_at ?? "9").localeCompare(b.first_at ?? "9") || a.name.localeCompare(b.name);
  });

  const project = walk.project_id ? (await tx<{ name: string; account_name: string | null }[]>`
    select p.name, a.name as account_name from shared.projects p left join shared.accounts a on a.id = p.account_id
     where p.id = ${walk.project_id} and p.organization_id = ${org}`)[0] ?? null : null;
  return {
    version: 1,
    walk: { id: walk.id, label: walk.label, status: walk.status, project_id: walk.project_id, project_name: project?.name ?? null, account_name: project?.account_name ?? null,
      address_hint: walk.address_hint, started_at: iso(walk.started_at)!, ended_at: iso(walk.ended_at), created_by: walk.created_by, created_by_name: members.get(walk.created_by) ?? null },
    exported_at: new Date().toISOString(),
    exported_by: { id: ctx.actorId, name: members.get(ctx.actorId) ?? null },
    rooms: ordered,
    counts: { rooms: ordered.length, notes: notes.length, media: media.length, placements: placements.length, sketches: sketches.length },
  };
}

//------------------------------------------------------------------------------
// POST /walks/:id/export
//------------------------------------------------------------------------------

async function readWalk(tx: Tx, id: string, org: string, lock = false): Promise<WalkRow | null> {
  const rows = lock
    ? await tx<WalkRow[]>`select id, project_id, account_id, status, label, address_hint, started_at, ended_at, created_by, deleted_at, device_id from places.walks where id = ${id} and organization_id = ${org} for update`
    : await tx<WalkRow[]>`select id, project_id, account_id, status, label, address_hint, started_at, ended_at, created_by, deleted_at, device_id from places.walks where id = ${id} and organization_id = ${org}`;
  return rows[0] ?? null;
}

export async function exportWalk(ctx: OrganizationContext, walkId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(walkId)) return { status: 400, body: { error: "walk id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  const days = b.expires_in_days == null ? DEFAULT_EXPIRES_DAYS : Number(b.expires_in_days);
  if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRES_DAYS) return { status: 400, body: { error: `expires_in_days must be a number in (0, ${MAX_EXPIRES_DAYS}]` } };
  const wid = walkId.toLowerCase();
  const org = ctx.organizationId;
  return withOrg(ctx, async (tx) => {
    const walk = await readWalk(tx, wid, org);
    if (!walk) return { status: 404, body: { error: "walk not found in this organization" } };
    if (walk.deleted_at) return { status: 409, body: { error: "walk is tombstoned" } };
    if (!mayManageWalk(ctx, walk)) return { status: 403, body: { error: "only designer, office, admin or the walk's creator may export it" } };
    const snapshot = await buildWalkSnapshot(tx, ctx, walk);
    const token = mintShareToken();
    const expires = new Date(Date.now() + days * 86_400_000);
    const rows = await tx<{ id: string; expires_at: Date }[]>`
      insert into places.walk_exports (organization_id, walk_id, project_id, snapshot_file_id, snapshot, share_token, expires_at, created_by)
      values (${org}, ${wid}, ${walk.project_id}, null, ${tx.json(snapshot as never)}, ${token}, ${expires}, ${ctx.actorId}) returning id, expires_at`;
    const exp = rows[0];
    await emitEvent(tx, ctx, {
      projectId: walk.project_id, refTable: "places.walk_exports", refId: exp.id, type: "walk.exported",
      payload: { walk_id: wid, expires_at: expires.toISOString(), counts: snapshot.counts, expires_in_days: days },
      key: `places.walk_exports:${exp.id}:created`,
    });
    return { status: 201, body: { op: "exported", export_id: exp.id, walk_id: wid, share_token: token, url: `/walk/${token}`, expires_at: exp.expires_at.toISOString(), counts: snapshot.counts } };
  });
}

//------------------------------------------------------------------------------
// Token resolution (GET /walk/:token · POST /walk/:token/reply)
//------------------------------------------------------------------------------

interface ExportRow {
  id: string;
  walk_id: string;
  project_id: string | null;
  snapshot: WalkSnapshot | null;
  expires_at: Date;
  revoked_at: Date | null;
  deleted_at: Date | null;
  created_by: string;
  created_at: Date;
}

type Resolved = { ok: true; exp: ExportRow } | { ok: false; status: number; error: string };

async function resolveToken(tx: Tx, token: string, org: string): Promise<Resolved> {
  if (!TOKEN_RE.test(token)) return { ok: false, status: 404, error: "no such review link" };
  const rows = await tx<ExportRow[]>`
    select id, walk_id, project_id, snapshot, expires_at, revoked_at, deleted_at, created_by, created_at
      from places.walk_exports where share_token = ${token} and organization_id = ${org}`;
  const exp = rows[0];
  if (!exp || exp.deleted_at) return { ok: false, status: 404, error: "no such review link" };
  if (exp.revoked_at) return { ok: false, status: 410, error: "this review link was revoked" };
  if (exp.expires_at.getTime() <= Date.now()) return { ok: false, status: 410, error: "this review link has expired" };
  if (!exp.snapshot) return { ok: false, status: 404, error: "this review link has no inline snapshot" };
  return { ok: true, exp };
}

export interface ReplyView { id: string; entry_id: string; entry_table: string; reply: string | null; checked: boolean; replied_by: string | null; received_at: Date; merged_at: Date | null; merge_outcome: string | null }

async function latestReplies(tx: Tx, exportId: string, org: string): Promise<Map<string, ReplyView>> {
  const rows = await tx<ReplyView[]>`
    select distinct on (entry_id) id, entry_id, entry_table, reply, checked, replied_by, received_at, merged_at, merge_outcome
      from places.walk_replies where export_id = ${exportId} and organization_id = ${org} order by entry_id, received_at desc, id desc`;
  return new Map(rows.map((r) => [r.entry_id, r]));
}

//------------------------------------------------------------------------------
// GET /walk/:token → HTML
//------------------------------------------------------------------------------

export async function renderWalkPage(ctx: OrganizationContext, token: string): Promise<HtmlResult> {
  const org = ctx.organizationId;
  return withOrgRead(ctx, async (tx) => {
    const r = await resolveToken(tx, token, org);
    if (!r.ok) return { status: r.status, body: errorPage(r.status, r.error), contentType: "text/html; charset=utf-8" };
    const replies = await latestReplies(tx, r.exp.id, org);
    return { status: 200, body: walkHtml(r.exp, replies, token, ctx), contentType: "text/html; charset=utf-8" };
  });
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function errorPage(status: number, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Walk review — ${status}</title>
<style>${CSS}</style></head><body><main class="wrap"><h1>Walk review</h1><p class="err">${escapeHtml(message)} (${status})</p></main></body></html>`;
}

const CSS = `
:root{--ink:#1b1f24;--muted:#5b6470;--line:#d9dee5;--bg:#f6f7f9;--card:#fff;--accent:#1f6feb;--ok:#1a7f37;--warn:#9a6700}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:900px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0}
.meta{color:var(--muted);font-size:13px;margin:0 0 16px}.meta span+span::before{content:" · "}
details.room{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 12px;break-inside:avoid}
details.room>summary{cursor:pointer;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;list-style:none}
details.room>summary::-webkit-details-marker{display:none}details.room>summary::after{content:"▸";color:var(--muted)}details.room[open]>summary::after{content:"▾"}
.count{color:var(--muted);font-size:13px;font-weight:normal}.entries{padding:0 14px 10px}
.entry{border-top:1px solid var(--line);padding:10px 0;display:grid;grid-template-columns:1fr;gap:6px}
.entry .head{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:13px;color:var(--muted)}
.kind{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--line);font-size:12px;text-transform:uppercase;letter-spacing:.02em}
.body{white-space:pre-wrap}.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted);user-select:all}
.reply{background:var(--bg);border-radius:8px;padding:8px 10px;font-size:14px}.reply b{color:var(--ok)}.reply.unmerged b{color:var(--warn)}
form.rb{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center}form.rb textarea{grid-column:1/-1;width:100%;min-height:44px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font:inherit}
form.rb label{font-size:13px;color:var(--muted)}form.rb button{padding:6px 12px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
form.rb .status{font-size:12px;color:var(--muted);grid-column:1/-1;min-height:1em}
.sketches{display:flex;gap:10px;flex-wrap:wrap;padding:0 14px 12px}.sketches figure{margin:0;width:200px}.sketches img{width:100%;border:1px solid var(--line);border-radius:6px;background:#fff}
.sketches figcaption{font-size:12px;color:var(--muted)}.photo{max-width:320px;max-height:240px;border:1px solid var(--line);border-radius:6px}
.err{color:#b42318}.empty{color:var(--muted);padding:0 14px 12px}
@media print{body{background:#fff}.wrap{max-width:none;padding:0}details.room{border:0;border-top:2px solid #000;border-radius:0}form.rb,.noprint{display:none!important}details.room>summary::after{content:""}}
`;

const JS = `
(function(){
  var root=document.documentElement;var actor=root.getAttribute('data-actor')||'';var org=root.getAttribute('data-org')||'';
  function post(form){
    var entry=form.getAttribute('data-entry');var table=form.getAttribute('data-table');
    var text=form.querySelector('textarea').value.trim();var checked=form.querySelector('input[type=checkbox]').checked;var st=form.querySelector('.status');
    if(!text&&!checked){st.textContent='Type a reply or tick checked.';return;}
    var h={'Content-Type':'application/json'};if(actor)h['X-Actor-Id']=actor;if(org)h['X-Organization-Id']=org;
    st.textContent='Sending…';
    fetch(root.getAttribute('data-reply-url'),{method:'POST',headers:h,credentials:'include',body:JSON.stringify({entry_id:entry,entry_table:table,reply:text||null,checked:checked})})
      .then(function(r){return r.json().then(function(b){return {ok:r.ok,b:b};});})
      .then(function(x){if(x.ok){st.textContent='Saved · '+(x.b.replied_by||'')+' · '+new Date(x.b.received_at).toLocaleString();var card=form.parentNode.querySelector('.reply');if(card){card.removeAttribute('hidden');card.className='reply unmerged';card.innerHTML='<b>Latest reply</b> ('+esc(x.b.replied_by||'')+'): '+esc(text||'')+(checked?' ✔':'');}}else{st.textContent='Not saved: '+(x.b.error||x.b.status||'error');}})
      .catch(function(e){st.textContent='Not saved: '+e;});
  }
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  document.addEventListener('submit',function(e){if(e.target&&e.target.classList.contains('rb')){e.preventDefault();post(e.target);}});
  window.addEventListener('beforeprint',function(){document.querySelectorAll('details.room').forEach(function(d){d.setAttribute('open','');});});
  var all=document.getElementById('toggle-all');if(all){all.addEventListener('click',function(){var ds=document.querySelectorAll('details.room');var open=!ds[0]||!ds[0].open;ds.forEach(function(d){if(open)d.setAttribute('open','');else d.removeAttribute('open');});});}
})();
`;

function fmt(isoStr: string | null): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? escapeHtml(isoStr) : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function walkHtml(exp: ExportRow, replies: Map<string, ReplyView>, token: string, ctx: OrganizationContext): string {
  const s = exp.snapshot!;
  const w = s.walk;
  const title = w.label ?? (w.project_name ? `${w.project_name} walk` : "Walk");
  const rooms = s.rooms.map((room) => {
    const entries = room.entries.map((e) => {
      const rep = replies.get(e.id);
      const replyCard = rep
        ? `<div class="reply${rep.merged_at ? "" : " unmerged"}"><b>Latest reply</b> (${escapeHtml(rep.replied_by ?? "")}, ${fmt(rep.received_at.toISOString())}${rep.merged_at ? ", merged" : ""}): ${escapeHtml(rep.reply ?? "")}${rep.checked ? " ✔" : ""}</div>`
        : `<div class="reply" hidden></div>`;
      const media = e.table === "places.location_media" && e.file_id
        ? `<div><a href="/files/${escapeHtml(e.file_id)}"><img class="photo" src="/files/${escapeHtml(e.file_id)}" alt="${escapeHtml(e.text ?? e.extra.filename ?? "photo")}" loading="lazy"></a></div>`
        : "";
      const kind = e.table === "places.device_placements" ? "as walked" : e.kind;
      return `<div class="entry" id="e-${escapeHtml(e.id)}">
  <div class="head"><span class="kind">${escapeHtml(kind)}</span>${e.location ? `<span>${escapeHtml(e.location)}</span>` : ""}${e.phase ? `<span>${escapeHtml(e.phase)}</span>` : ""}<span>${fmt(e.occurred_at)}</span>${e.by ? `<span>${escapeHtml(e.by)}</span>` : ""}<span class="id">${escapeHtml(e.id)}</span></div>
  ${e.text ? `<div class="body">${escapeHtml(e.text)}</div>` : ""}${media}
  ${replyCard}
  <form class="rb noprint" data-entry="${escapeHtml(e.id)}" data-table="${escapeHtml(e.table)}">
    <textarea name="reply" placeholder="Reply…"></textarea>
    <label><input type="checkbox" name="checked"> checked</label><span></span><button type="submit">Send</button>
    <div class="status"></div>
  </form>
</div>`;
    }).join("\n");
    const sketches = room.sketches.length
      ? `<div class="sketches">${room.sketches.map((k) => `<figure>${k.preview_file_id ? `<a href="/files/${escapeHtml(k.preview_file_id)}"><img src="/files/${escapeHtml(k.preview_file_id)}" alt="${escapeHtml(k.name ?? "sketch")}" loading="lazy"></a>` : `<div class="empty">no preview yet</div>`}<figcaption>${escapeHtml(k.name ?? `Sketch ${k.ordinal}`)} <span class="id">${escapeHtml(k.page_id)}</span></figcaption></figure>`).join("")}</div>`
      : "";
    const n = room.entries.length;
    return `<details class="room" id="r-${escapeHtml(room.key)}"><summary><h2>${escapeHtml(room.name)}</h2><span class="count">${n} ${n === 1 ? "entry" : "entries"}${room.sketches.length ? ` · ${room.sketches.length} sketch${room.sketches.length === 1 ? "" : "es"}` : ""}</span></summary>
${sketches}${n ? `<div class="entries">${entries}</div>` : `<div class="empty">No captures in this room.</div>`}</details>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en" data-reply-url="/walk/${escapeHtml(token)}/reply" data-actor="${escapeHtml(ctx.actorId)}" data-org="${escapeHtml(ctx.organizationId)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} — walk review</title>
<style>${CSS}</style></head>
<body><main class="wrap">
<h1>${escapeHtml(title)}</h1>
<p class="meta">${w.project_name ? `<span>${escapeHtml(w.project_name)}</span>` : ""}${w.account_name ? `<span>${escapeHtml(w.account_name)}</span>` : ""}${w.address_hint ? `<span>${escapeHtml(w.address_hint)}</span>` : ""}<span>walked ${fmt(w.started_at)}${w.created_by_name ? ` by ${escapeHtml(w.created_by_name)}` : ""}</span><span>exported ${fmt(s.exported_at)}</span><span>expires ${fmt(exp.expires_at.toISOString())}</span><span>${s.counts.rooms} rooms · ${s.counts.notes} notes · ${s.counts.media} photos · ${s.counts.placements} as-walked · ${s.counts.sketches} sketches</span></p>
<p class="noprint"><button type="button" id="toggle-all">Expand / collapse all</button></p>
${rooms || `<p class="empty">This walk has no captures.</p>`}
<p class="meta">Review link ${escapeHtml(exp.id)} · walk ${escapeHtml(w.id)} · replies are merged add-only; the app's own text is never changed.</p>
</main><script>${JS}</script></body></html>`;
}

//------------------------------------------------------------------------------
// POST /walk/:token/reply
//------------------------------------------------------------------------------

export async function postWalkReply(ctx: OrganizationContext, token: string, body: unknown): Promise<RouteResult> {
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.entry_id)) return { status: 400, body: { error: "entry_id (UUID) is required" } };
  const reply = typeof b.reply === "string" && b.reply.trim() ? b.reply.trim() : null;
  const checked = b.checked === true || b.checked === "true";
  if (!reply && !checked) return { status: 400, body: { error: "reply (text) or checked (true) is required" } };
  if (b.entry_table != null && !(ENTRY_TABLES as readonly unknown[]).includes(b.entry_table)) return { status: 400, body: { error: `entry_table must be one of ${ENTRY_TABLES.join(" | ")}` } };
  if (b.replied_by != null && typeof b.replied_by !== "string") return { status: 400, body: { error: "replied_by must be a string" } };
  const entryId = (b.entry_id as string).toLowerCase();
  const org = ctx.organizationId;
  return withOrg(ctx, async (tx) => {
    const r = await resolveToken(tx, token, org);
    if (!r.ok) return { status: r.status, body: { error: r.error } };
    // entry_table: as sent, else from the snapshot, else notes (the id may be typo'd — stored as-is, matched at pull time)
    let table: EntryTable | null = (b.entry_table as EntryTable | undefined) ?? null;
    if (!table) {
      for (const room of r.exp.snapshot!.rooms) {
        const e = room.entries.find((x) => x.id === entryId);
        if (e) { table = e.table; break; }
      }
    }
    table = table ?? "places.location_notes";
    let repliedBy = typeof b.replied_by === "string" && b.replied_by.trim() ? b.replied_by.trim().slice(0, 200) : null;
    if (!repliedBy) {
      const m = await tx<{ display_name: string; email: string | null }[]>`select display_name, email from shared.members where id = ${ctx.actorId} and organization_id = ${org}`;
      repliedBy = m[0]?.display_name || m[0]?.email || null;
    }
    const rows = await tx<{ id: string; received_at: Date }[]>`
      insert into places.walk_replies (organization_id, export_id, entry_id, entry_table, reply, checked, replied_by)
      values (${org}, ${r.exp.id}, ${entryId}, ${table}, ${reply}, ${checked}, ${repliedBy}) returning id, received_at`;
    const row = rows[0];
    await emitEvent(tx, ctx, {
      projectId: r.exp.project_id, refTable: "places.walk_replies", refId: row.id, type: "walk.reply_received",
      payload: { export_id: r.exp.id, walk_id: r.exp.walk_id, entry_id: entryId, entry_table: table, checked, has_text: !!reply, replied_by: repliedBy },
      key: `places.walk_replies:${row.id}:received`,
    });
    return { status: 201, body: { op: "received", reply_id: row.id, export_id: r.exp.id, entry_id: entryId, entry_table: table, replied_by: repliedBy, checked, received_at: row.received_at.toISOString() } };
  });
}

//------------------------------------------------------------------------------
// POST /walks/:id/pull-replies — ADD-ONLY merge
//------------------------------------------------------------------------------

interface PendingReply extends ReplyView { export_id: string }

export async function pullReplies(ctx: OrganizationContext, walkId: string): Promise<RouteResult> {
  if (!isUuid(walkId)) return { status: 400, body: { error: "walk id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const wid = walkId.toLowerCase();
  const org = ctx.organizationId;
  return withOrg(ctx, async (tx) => {
    const walk = await readWalk(tx, wid, org, true);
    if (!walk) return { status: 404, body: { error: "walk not found in this organization" } };
    if (walk.deleted_at) return { status: 409, body: { error: "walk is tombstoned" } };
    if (!mayManageWalk(ctx, walk)) return { status: 403, body: { error: "only designer, office, admin or the walk's creator may pull replies" } };

    const skippedRows = await tx<{ n: string }[]>`
      select count(*)::text as n from places.walk_replies r join places.walk_exports e on e.id = r.export_id and e.organization_id = r.organization_id
       where e.walk_id = ${wid} and r.organization_id = ${org} and r.merged_at is not null`;
    const pending = await tx<PendingReply[]>`
      select r.id, r.export_id, r.entry_id, r.entry_table, r.reply, r.checked, r.replied_by, r.received_at, r.merged_at, r.merge_outcome
        from places.walk_replies r join places.walk_exports e on e.id = r.export_id and e.organization_id = r.organization_id
       where e.walk_id = ${wid} and r.organization_id = ${org} and r.merged_at is null
       order by r.received_at, r.id for update of r`;

    const merged: { reply_id: string; note_id: string; entry_table: string; entry_id: string }[] = [];
    const unmatched: { reply_id: string; entry_table: string; entry_id: string; action_item_id: string | null }[] = [];
    const now = new Date();
    for (const r of pending) {
      const entry = await findEntry(tx, r.entry_table as EntryTable, r.entry_id, wid, org);
      if (entry) {
        const body = r.reply ?? (r.checked ? "[checked]" : "");
        const note = await tx<{ id: string }[]>`
          insert into places.location_notes (organization_id, account_id, project_id, room_id, room_hint, location_id, location_hint, kind, phase, note_layer, body, custom,
                                             revision, occurred_at, device_id, created_by, walk_id, captured_revision)
          values (${org}, ${entry.account_id}, ${entry.project_id}, ${entry.room_id}, ${entry.room_hint}, ${entry.location_id}, ${entry.location_hint}, 'reply', ${entry.phase}, 'office',
                  ${body}, ${tx.json({ walk_reply_id: r.id, export_id: r.export_id, replied_by: r.replied_by, checked: r.checked, reply_to_table: r.entry_table, reply_to_id: r.entry_id, source: "walk_review_link" } as never)},
                  1, ${r.received_at}, null, ${ctx.actorId}, ${wid}, null) returning id`;
        const noteId = note[0].id;
        await tx`update places.walk_replies set merged_at = ${now}, merged_note_id = ${noteId}, merge_outcome = 'matched' where id = ${r.id} and organization_id = ${org}`;
        await emitEvent(tx, ctx, {
          projectId: entry.project_id, refTable: "places.location_notes", refId: noteId, type: "walk_reply.merged",
          payload: { op: "created", class: "capture", revision: 1, walk_id: wid, walk_reply_id: r.id, reply_to_table: r.entry_table, reply_to_id: r.entry_id, checked: r.checked },
          key: `places.location_notes:${noteId}:1`,
        });
        merged.push({ reply_id: r.id, note_id: noteId, entry_table: r.entry_table, entry_id: r.entry_id });
      } else {
        const row: JsonRow = { ...r, walk_id: wid, project_id: walk.project_id, account_id: walk.account_id, body: r.reply ?? (r.checked ? "[checked]" : ""), deleted_at: null };
        await emitEvent(tx, ctx, {
          projectId: walk.project_id, refTable: "places.walk_replies", refId: r.id, type: "walk_reply.unmatched",
          payload: { walk_id: wid, export_id: r.export_id, entry_table: r.entry_table, entry_id: r.entry_id, replied_by: r.replied_by, checked: r.checked },
          key: `places.walk_replies:${r.id}:unmatched`,
        });
        const outcomes = await evaluateRules(tx, { organizationId: org, actorId: ctx.actorId || null, eventType: "walk_reply.unmatched", refTable: "places.walk_replies", refId: r.id, row, projectId: walk.project_id });
        const made = outcomes.find((o) => o.result === "created")?.actionItemId ?? null;
        await tx`update places.walk_replies set merged_at = ${now}, merge_outcome = 'unmatched' where id = ${r.id} and organization_id = ${org}`;
        unmatched.push({ reply_id: r.id, entry_table: r.entry_table, entry_id: r.entry_id, action_item_id: made });
      }
    }
    const skipped = Number(skippedRows[0]?.n ?? 0);
    await emitEvent(tx, ctx, {
      projectId: walk.project_id, refTable: "places.walks", refId: wid, type: "walk.replies_pulled",
      payload: { merged: merged.length, unmatched: unmatched.length, skipped, note_ids: merged.map((m) => m.note_id), unmatched_reply_ids: unmatched.map((u) => u.reply_id) },
      key: `places.walks:${wid}:replies_pulled:${now.getTime()}`,
    });
    return { status: 200, body: { op: "pulled", walk_id: wid, merged: merged.length, unmatched: unmatched.length, skipped, merged_rows: merged, unmatched_rows: unmatched } };
  });
}

interface EntryRow { account_id: string | null; project_id: string | null; room_id: string | null; room_hint: string | null; location_id: string | null; location_hint: string | null; phase: string | null }

/** The LIVE row the reply points at — and it must belong to THIS walk (a reply never lands on another walk's capture). */
async function findEntry(tx: Tx, table: EntryTable, id: string, walkId: string, org: string): Promise<EntryRow | null> {
  if (!(ENTRY_TABLES as readonly string[]).includes(table)) return null;
  const rows = await tx<EntryRow[]>`
    select account_id, project_id, room_id, room_hint, location_id, location_hint, phase from ${tx(table)}
     where id = ${id} and organization_id = ${org} and walk_id = ${walkId} and deleted_at is null`;
  return rows[0] ?? null;
}
