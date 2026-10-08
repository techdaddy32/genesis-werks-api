// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
//==============================================================================
// sync/files.ts — the `put_url` for file rows still upload_status = 'pending'
// (walk spec §5.4 / §5.7), and the PUT handler that receives the bytes.
//
// HONEST NOTE ON "PRESIGNED": an R2 *binding* (env.FILES) cannot mint an S3-style
// presigned URL — that needs R2 S3 API credentials (account id + access key +
// secret) signed with SigV4, i.e. secrets this row may not add. So the W1 put_url is
// a WORKER-MEDIATED upload: `PUT <worker origin>/sync/files/<file_id>` with the same
// sandbox auth headers as /sync/push. The Worker streams the body into env.FILES at
// the deterministic key `<organization_id>/<file_id>` (shared.files.storage_key) and
// flips the row pending → uploaded (monotone; sha256 recorded, verified is W2's cron).
// Row W2 ("files presign + upload_status + orphan sweep") can swap `putUrlFor` for a
// true presigner without touching push.ts — this module is the seam.
//==============================================================================

import type { OrganizationContext } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";

/** Builds the PUT url for a pending file. `origin` = the Worker's own origin for this request. */
export function putUrlFor(origin: string): (fileId: string) => string {
  const base = origin.replace(/\/+$/, "");
  return (fileId) => `${base}/sync/files/${fileId}`;
}

/** The subset of R2Bucket the upload path uses — tests stub exactly this. */
export interface FileSink {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: { contentType?: string }; sha256?: string }): Promise<unknown>;
}

export interface UploadResult {
  status: number;
  body: Record<string, unknown>;
}

interface FileRow {
  id: string;
  storage_key: string;
  upload_status: "pending" | "uploaded" | "verified";
  content_type: string;
  sha256: string | null;
  created_by: string;
}

/**
 * PUT /sync/files/:id — body = the bytes. Only the row's creator (or an admin) may upload;
 * only a 'pending' row accepts bytes (monotone: a second PUT is a 409, never a downgrade).
 * sha256 is computed server-side over the received bytes; if the row already carries an
 * expected sha256 and it differs → 422 and the row stays 'pending' (bytes are not kept).
 */
export async function receiveFileBytes(ctx: OrganizationContext, sink: FileSink | undefined, fileId: string, request: Request): Promise<UploadResult> {
  if (!isUuid(fileId)) return { status: 400, body: { error: "file id must be a UUID" } };
  if (!sink) return { status: 503, body: { error: "FILES binding is not configured" } };

  const row = await withOrg(ctx, async (tx) => {
    const rows = await tx<FileRow[]>`
      select id, storage_key, upload_status, content_type, sha256, created_by
        from shared.files where id = ${fileId.toLowerCase()} and organization_id = ${ctx.organizationId} and deleted_at is null`;
    return rows[0] ?? null;
  });
  if (!row) return { status: 404, body: { error: "file row not found" } };
  if (row.created_by !== ctx.actorId && !ctx.isAdmin) return { status: 403, body: { error: "only the file's creator may upload its bytes" } };
  if (row.upload_status !== "pending") return { status: 409, body: { error: `file is already ${row.upload_status}`, upload_status: row.upload_status } };

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return { status: 400, body: { error: "empty body" } };
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (row.sha256 && row.sha256 !== sha256) {
    return { status: 422, body: { error: "sha256 mismatch", expected: row.sha256, received: sha256 } };
  }

  await sink.put(row.storage_key, bytes, { httpMetadata: { contentType: request.headers.get("Content-Type") ?? row.content_type } });

  const updated = await withOrg(ctx, async (tx) => {
    const rows = await tx<{ upload_status: string }[]>`
      update shared.files
         set upload_status = 'uploaded', sha256 = ${sha256}, byte_size = coalesce(byte_size, ${bytes.byteLength})
       where id = ${row.id} and organization_id = ${ctx.organizationId} and upload_status = 'pending'
       returning upload_status`;
    if (rows.length === 1) {
      await tx`
        insert into shared.events (organization_id, ref_table, ref_id, event_type, payload, actor, actor_type, idempotency_key)
        values (${ctx.organizationId}, 'shared.files', ${row.id}, 'file.uploaded',
                ${tx.json({ sha256, byte_size: bytes.byteLength, storage_key: row.storage_key } as never)},
                ${ctx.actorId}, 'member', ${`shared.files:${row.id}:uploaded`})
        on conflict (organization_id, idempotency_key) do nothing`;
    }
    return rows[0] ?? null;
  });
  if (!updated) return { status: 409, body: { error: "file state changed during upload" } };
  return { status: 200, body: { file_id: row.id, upload_status: "uploaded", sha256, byte_size: bytes.byteLength, storage_key: row.storage_key } };
}
