// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07 — hardened PUT; POST /files; POST /files/:id/uploaded; verify + orphan sweep (cron)
//==============================================================================
// sync/files.ts — shared.files lifecycle (walk spec §5.4, §6 check 6).
//
//   pending ──(bytes land)──▶ uploaded ──(cron: sha256 matches R2)──▶ verified     (monotone)
//
// HONEST NOTE ON "PRESIGNED" (W1, confirmed by Craig 2026-10-07): an R2 *binding* cannot
// mint an S3 presigned URL (needs R2 S3 credentials = secrets). put_url stays WORKER-
// MEDIATED: `PUT <worker origin>/sync/files/<file_id>` with the same auth headers. The
// Worker streams the body into env.FILES at the deterministic key `<org>/<file_id>`
// (shared.files.storage_key, CHECK-enforced) and flips pending → uploaded.
//
//   POST /files                       create a 'pending' row (storage_key <org>/<id>) → 201 {put_url}
//   PUT  /sync/files/:id              bytes (creator or admin; pending only; 409 on a re-PUT;
//                                     422 on declared-sha mismatch; 413 over MAX_UPLOAD_BYTES)
//   POST /files/:id/uploaded {sha256} the device declares the bytes are in R2 (used when bytes
//                                     went up out-of-band) → 'uploaded'; the cron verifies.
//   cron verifyUploadedFiles          'uploaded' rows: sha256 vs R2 (checksum header when
//                                     present, else a streamed digest) → 'verified'; mismatch →
//                                     event file.verify_failed, row stays 'uploaded'; object
//                                     missing → event file.bytes_missing. NEVER a delete.
//   cron orphanSweep                  rows 'pending' > 7 days + R2 keys under <org>/ with no
//                                     row → ONE shared.events 'files.orphan_report' per org per
//                                     day (payload = the lists). Reports only — nothing is
//                                     deleted, by anyone, ever (walk spec §5.4).
//==============================================================================

import type { OrganizationContext } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { emitEvent, type RouteResult } from "./checkout";

/** Builds the PUT url for a pending file. `origin` = the Worker's own origin for this request. */
export function putUrlFor(origin: string): (fileId: string) => string {
  const base = origin.replace(/\/+$/, "");
  return (fileId) => `${base}/sync/files/${fileId}`;
}

/** The subset of R2Bucket the upload path uses — tests stub exactly this. */
export interface FileSink {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: { contentType?: string }; sha256?: string }): Promise<unknown>;
}

/** What the cron needs on top of put: head/get for verification, list for the orphan sweep. */
export interface FileStore extends FileSink {
  head(key: string): Promise<{ size: number; checksums?: { sha256?: ArrayBuffer } } | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
}

export type UploadResult = RouteResult;

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB per object in v1 (plan PDFs, photos)
export const ORPHAN_PENDING_DAYS = 7;

interface FileRow {
  id: string;
  storage_key: string;
  upload_status: "pending" | "uploaded" | "verified";
  content_type: string;
  sha256: string | null;
  byte_size: number | string | null;
  created_by: string;
  project_id: string | null;
  received_at: Date;
}

const SHA_RE = /^[0-9a-f]{64}$/;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

//------------------------------------------------------------------------------
// PUT /sync/files/:id (W1, hardened)
//------------------------------------------------------------------------------

/**
 * PUT /sync/files/:id — body = the bytes. Only the row's creator (or an admin) may upload;
 * only a 'pending' row accepts bytes (monotone: a second PUT is a 409, never a downgrade).
 * sha256 is computed server-side over the received bytes; if the row already carries an
 * expected sha256 and it differs → 422 and the row stays 'pending' (bytes are not kept).
 * W2 hardening: declared Content-Length / body over MAX_UPLOAD_BYTES → 413 before reading;
 * the sha256 is handed to R2 (put option) so the cron can verify from the checksum header;
 * byte_size is always recorded; the pending→uploaded flip is conditional (race-safe).
 */
export async function receiveFileBytes(ctx: OrganizationContext, sink: FileSink | undefined, fileId: string, request: Request): Promise<UploadResult> {
  if (!isUuid(fileId)) return { status: 400, body: { error: "file id must be a UUID" } };
  if (!sink) return { status: 503, body: { error: "FILES binding is not configured" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const declaredLen = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES) return { status: 413, body: { error: `body exceeds ${MAX_UPLOAD_BYTES} bytes` } };

  const row = await withOrg(ctx, async (tx) => {
    const rows = await tx<FileRow[]>`
      select id, storage_key, upload_status, content_type, sha256, byte_size, created_by, project_id, received_at
        from shared.files where id = ${fileId.toLowerCase()} and organization_id = ${ctx.organizationId} and deleted_at is null`;
    return rows[0] ?? null;
  });
  if (!row) return { status: 404, body: { error: "file row not found" } };
  if (row.created_by !== ctx.actorId && !ctx.isAdmin) return { status: 403, body: { error: "only the file's creator may upload its bytes" } };
  if (row.upload_status !== "pending") return { status: 409, body: { error: `file is already ${row.upload_status}`, upload_status: row.upload_status } };

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return { status: 400, body: { error: "empty body" } };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { status: 413, body: { error: `body exceeds ${MAX_UPLOAD_BYTES} bytes` } };
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (row.sha256 && row.sha256 !== sha256) {
    return { status: 422, body: { error: "sha256 mismatch", expected: row.sha256, received: sha256 } };
  }

  await sink.put(row.storage_key, bytes, { httpMetadata: { contentType: request.headers.get("Content-Type") ?? row.content_type }, sha256 });

  const updated = await withOrg(ctx, async (tx) => {
    const rows = await tx<{ upload_status: string }[]>`
      update shared.files
         set upload_status = 'uploaded', sha256 = ${sha256}, byte_size = ${bytes.byteLength}, received_at = now()
       where id = ${row.id} and organization_id = ${ctx.organizationId} and upload_status = 'pending'
       returning upload_status`;
    if (rows.length === 1) {
      await emitEvent(tx, ctx, {
        projectId: row.project_id, refTable: "shared.files", refId: row.id, type: "file.uploaded",
        payload: { sha256, byte_size: bytes.byteLength, storage_key: row.storage_key, via: "worker_put" },
        key: `shared.files:${row.id}:uploaded`,
      });
    }
    return rows[0] ?? null;
  });
  if (!updated) return { status: 409, body: { error: "file state changed during upload" } };
  return { status: 200, body: { file_id: row.id, upload_status: "uploaded", sha256, byte_size: bytes.byteLength, storage_key: row.storage_key } };
}

//------------------------------------------------------------------------------
// POST /files
//------------------------------------------------------------------------------

const FILE_KINDS = new Set(["photo", "plan_source", "page_preview", "export", "walk_snapshot", "attachment"]);

export async function createFile(ctx: OrganizationContext, body: unknown, putUrl: (id: string) => string): Promise<RouteResult> {
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.id != null && !isUuid(b.id)) return { status: 400, body: { error: "id must be a UUID when given" } };
  if (typeof b.filename !== "string" || !b.filename.trim()) return { status: 400, body: { error: "filename is required" } };
  const kind = typeof b.kind === "string" && FILE_KINDS.has(b.kind) ? b.kind : b.kind == null ? "attachment" : null;
  if (!kind) return { status: 400, body: { error: `kind must be one of ${[...FILE_KINDS].join(" | ")}` } };
  for (const col of ["project_id", "account_id", "walk_id"]) if (b[col] != null && !isUuid(b[col])) return { status: 400, body: { error: `${col} must be a UUID` } };
  const sha = typeof b.sha256 === "string" ? b.sha256.trim().toLowerCase() : null;
  if (sha && !SHA_RE.test(sha)) return { status: 400, body: { error: "sha256 must be 64 lowercase hex chars" } };
  const byteSize = b.byte_size == null ? null : Number(b.byte_size);
  if (byteSize != null && (!Number.isInteger(byteSize) || byteSize < 0)) return { status: 400, body: { error: "byte_size must be a non-negative integer" } };
  const occurredAt = b.occurred_at == null ? new Date() : new Date(String(b.occurred_at));
  if (Number.isNaN(occurredAt.getTime())) return { status: 400, body: { error: "occurred_at must be ISO-8601" } };
  const id = ((b.id as string | undefined) ?? crypto.randomUUID()).toLowerCase();
  const contentType = typeof b.content_type === "string" && b.content_type.trim() ? b.content_type.trim() : "application/octet-stream";
  const deviceId = typeof b.device_id === "string" && b.device_id.trim() ? b.device_id.trim() : null;

  return withOrg(ctx, async (tx) => {
    const existing = await tx<FileRow[]>`
      select id, storage_key, upload_status, content_type, sha256, byte_size, created_by, project_id, received_at
        from shared.files where id = ${id} and organization_id = ${ctx.organizationId}`;
    if (existing[0]) {
      const e = existing[0];
      return { status: 200, body: { op: "noop", file_id: e.id, storage_key: e.storage_key, upload_status: e.upload_status, ...(e.upload_status === "pending" ? { put_url: putUrl(e.id) } : {}) } };
    }
    for (const [col, target] of [["project_id", "shared.projects"], ["account_id", "shared.accounts"], ["walk_id", "places.walks"]] as const) {
      if (b[col] == null) continue;
      const ok = await tx<{ one: number }[]>`select 1 as one from ${tx(target)} where id = ${(b[col] as string).toLowerCase()} and organization_id = ${ctx.organizationId}`;
      if (!ok.length) return { status: 422, body: { error: `${col} not found in this organization` } };
    }
    const storageKey = `${ctx.organizationId}/${id}`;
    let rows: FileRow[];
    try {
      rows = await tx<FileRow[]>`
        insert into shared.files (id, organization_id, account_id, project_id, kind, filename, content_type, byte_size, sha256, storage_key, upload_status,
                                  revision, occurred_at, device_id, created_by, walk_id, custom)
        values (${id}, ${ctx.organizationId}, ${((b.account_id as string | undefined) ?? null)?.toLowerCase() ?? null}, ${((b.project_id as string | undefined) ?? null)?.toLowerCase() ?? null},
                ${kind}, ${(b.filename as string).trim()}, ${contentType}, ${byteSize}, ${sha}, ${storageKey}, 'pending',
                1, ${occurredAt}, ${deviceId}, ${ctx.actorId}, ${((b.walk_id as string | undefined) ?? null)?.toLowerCase() ?? null},
                ${tx.json((b.custom && typeof b.custom === "object" ? b.custom : {}) as never)})
        returning id, storage_key, upload_status, content_type, sha256, byte_size, created_by, project_id, received_at`;
    } catch (e) {
      if ((e as { code?: string })?.code === "23505") return { status: 409, body: { error: "a file with this id exists outside this organization" } };
      throw e;
    }
    const f = rows[0];
    await emitEvent(tx, ctx, {
      projectId: f.project_id, refTable: "shared.files", refId: f.id, type: "file.created",
      payload: { op: "created", kind, storage_key: storageKey, via: "POST /files" }, key: `shared.files:${f.id}:1`, deviceId,
    });
    return { status: 201, body: { op: "created", file_id: f.id, storage_key: f.storage_key, upload_status: "pending", put_url: putUrl(f.id) } };
  });
}

//------------------------------------------------------------------------------
// POST /files/:id/uploaded {sha256, byte_size?}
//------------------------------------------------------------------------------

export async function markUploaded(ctx: OrganizationContext, fileId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(fileId)) return { status: 400, body: { error: "file id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  const sha = typeof b.sha256 === "string" ? b.sha256.trim().toLowerCase() : "";
  if (!SHA_RE.test(sha)) return { status: 400, body: { error: "sha256 (64 hex chars) is required" } };
  const byteSize = b.byte_size == null ? null : Number(b.byte_size);
  if (byteSize != null && (!Number.isInteger(byteSize) || byteSize < 0)) return { status: 400, body: { error: "byte_size must be a non-negative integer" } };
  const id = fileId.toLowerCase();

  return withOrg(ctx, async (tx) => {
    const rows = await tx<FileRow[]>`
      select id, storage_key, upload_status, content_type, sha256, byte_size, created_by, project_id, received_at
        from shared.files where id = ${id} and organization_id = ${ctx.organizationId} and deleted_at is null for update`;
    const row = rows[0];
    if (!row) return { status: 404, body: { error: "file row not found" } };
    if (row.created_by !== ctx.actorId && !ctx.isAdmin) return { status: 403, body: { error: "only the file's creator may mark it uploaded" } };
    if (row.upload_status !== "pending") {
      if (row.sha256 === sha) return { status: 200, body: { op: "noop", file_id: row.id, upload_status: row.upload_status, sha256: row.sha256 } };
      return { status: 409, body: { error: `file is already ${row.upload_status} with a different sha256`, upload_status: row.upload_status } };
    }
    if (row.sha256 && row.sha256 !== sha) return { status: 422, body: { error: "sha256 mismatch with the declared value on the row", expected: row.sha256, received: sha } };
    await tx`
      update shared.files set upload_status = 'uploaded', sha256 = ${sha}, byte_size = coalesce(${byteSize}, byte_size), received_at = now()
       where id = ${row.id} and organization_id = ${ctx.organizationId} and upload_status = 'pending'`;
    await emitEvent(tx, ctx, {
      projectId: row.project_id, refTable: "shared.files", refId: row.id, type: "file.uploaded",
      payload: { sha256: sha, byte_size: byteSize ?? row.byte_size, storage_key: row.storage_key, via: "declared" },
      key: `shared.files:${row.id}:uploaded`,
    });
    return { status: 200, body: { op: "uploaded", file_id: row.id, upload_status: "uploaded", sha256: sha, storage_key: row.storage_key } };
  });
}

//------------------------------------------------------------------------------
// Cron: verify 'uploaded' → 'verified'
//------------------------------------------------------------------------------

export interface VerifyResult {
  organization_id: string;
  checked: number;
  verified: string[];
  mismatched: string[];
  missing: string[];
}

export async function verifyUploadedFiles(ctx: OrganizationContext, store: FileStore, limit = 200): Promise<VerifyResult> {
  const out: VerifyResult = { organization_id: ctx.organizationId, checked: 0, verified: [], mismatched: [], missing: [] };
  const candidates = await withOrg(ctx, (tx) => tx<FileRow[]>`
    select id, storage_key, upload_status, content_type, sha256, byte_size, created_by, project_id, received_at
      from shared.files
     where organization_id = ${ctx.organizationId} and upload_status = 'uploaded' and deleted_at is null
     order by received_at limit ${limit}`);
  for (const f of candidates) {
    out.checked += 1;
    const head = await store.head(f.storage_key);
    if (!head) {
      await withOrg(ctx, (tx) => emitEvent(tx, ctx, {
        projectId: f.project_id, refTable: "shared.files", refId: f.id, type: "file.bytes_missing",
        payload: { storage_key: f.storage_key, expected_sha256: f.sha256 }, key: `shared.files:${f.id}:bytes_missing:${new Date().toISOString().slice(0, 10)}`,
      }));
      out.missing.push(f.id);
      continue;
    }
    let actual: string | null = head.checksums?.sha256 ? hex(head.checksums.sha256) : null;
    if (!actual) {
      const obj = await store.get(f.storage_key);
      if (!obj) { out.missing.push(f.id); continue; }
      actual = hex(await crypto.subtle.digest("SHA-256", await obj.arrayBuffer()));
    }
    if (f.sha256 && actual === f.sha256) {
      await withOrg(ctx, async (tx) => {
        const r = await tx<{ id: string }[]>`
          update shared.files set upload_status = 'verified', byte_size = coalesce(byte_size, ${head.size}), received_at = now()
           where id = ${f.id} and organization_id = ${ctx.organizationId} and upload_status = 'uploaded' returning id`;
        if (r.length) {
          await emitEvent(tx, ctx, {
            projectId: f.project_id, refTable: "shared.files", refId: f.id, type: "file.verified",
            payload: { sha256: actual, byte_size: head.size, storage_key: f.storage_key }, key: `shared.files:${f.id}:verified`,
          });
        }
      });
      out.verified.push(f.id);
    } else {
      await withOrg(ctx, (tx) => emitEvent(tx, ctx, {
        projectId: f.project_id, refTable: "shared.files", refId: f.id, type: "file.verify_failed",
        payload: { storage_key: f.storage_key, expected_sha256: f.sha256, actual_sha256: actual, byte_size: head.size },
        key: `shared.files:${f.id}:verify_failed:${f.sha256 ?? "none"}:${actual}`,
      }));
      out.mismatched.push(f.id);
    }
  }
  return out;
}

//------------------------------------------------------------------------------
// Cron: orphan sweep — REPORT ONLY
//------------------------------------------------------------------------------

export interface OrphanReport {
  organization_id: string;
  pending_over_threshold: { file_id: string; storage_key: string; received_at: Date; project_id: string | null }[];
  r2_without_row: { key: string; size: number }[];
  r2_keys_scanned: number;
  event_written: boolean;
}

export interface OrphanSweepOptions {
  now?: Date;
  pendingAfterMs?: number;
  /** Max R2 keys to scan under <org>/ per run (the list is paged). */
  maxKeys?: number;
}

export async function orphanSweep(ctx: OrganizationContext, store: FileStore, opts: OrphanSweepOptions = {}): Promise<OrphanReport> {
  const now = opts.now ?? new Date();
  const threshold = new Date(now.getTime() - (opts.pendingAfterMs ?? ORPHAN_PENDING_DAYS * 86_400_000));
  const maxKeys = opts.maxKeys ?? 10_000;

  // 1. rows pending too long
  const pending = await withOrg(ctx, (tx) => tx<{ file_id: string; storage_key: string; received_at: Date; project_id: string | null }[]>`
    select id as file_id, storage_key, received_at, project_id from shared.files
     where organization_id = ${ctx.organizationId} and upload_status = 'pending' and deleted_at is null and received_at < ${threshold}
     order by received_at`);

  // 2. R2 keys under <org>/ with no row
  const prefix = `${ctx.organizationId}/`;
  const keys: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && keys.length < maxKeys);
  const candidateIds = keys.map((k) => k.key.slice(prefix.length)).filter((s) => isUuid(s));
  const known = new Set<string>();
  if (candidateIds.length) {
    const rows = await withOrg(ctx, (tx) => tx<{ id: string }[]>`
      select id from shared.files where organization_id = ${ctx.organizationId} and id in ${tx(candidateIds)}`);
    for (const r of rows) known.add(r.id);
  }
  const orphans = keys.filter((k) => {
    const id = k.key.slice(prefix.length);
    return !isUuid(id) || !known.has(id.toLowerCase());
  });

  // 3. ONE report event per org per day — nothing deleted, nothing updated
  let written = false;
  if (pending.length || orphans.length) {
    written = await withOrg(ctx, (tx) => emitEvent(tx, ctx, {
      projectId: null, refTable: "shared.files", refId: null, type: "files.orphan_report",
      payload: {
        pending_over_threshold: pending.map((p) => ({ file_id: p.file_id, storage_key: p.storage_key, received_at: p.received_at, project_id: p.project_id })),
        r2_without_row: orphans,
        threshold: threshold.toISOString(),
        r2_keys_scanned: keys.length,
        policy: "report only — never deleted (walk spec §5.4)",
      },
      key: `shared.files:${ctx.organizationId}:orphan_report:${now.toISOString().slice(0, 10)}`,
    }));
  }
  return { organization_id: ctx.organizationId, pending_over_threshold: pending, r2_without_row: orphans, r2_keys_scanned: keys.length, event_written: written };
}
