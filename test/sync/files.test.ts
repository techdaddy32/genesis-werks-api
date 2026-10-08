// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
// shared.files lifecycle (walk spec §5.4, §6 check 6): POST /files → PUT bytes (or declared uploaded) → cron verify → verified;
// orphan sweep REPORTS (event) and deletes nothing. R2 is the in-memory MemorySink.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, ownerEvents, ownerRow, MemorySink, type Sql, type TestOrg } from "./_db";
import { verifyUploadedFiles, orphanSweep, MAX_UPLOAD_BYTES } from "../../src/sync/files";
import { systemContext } from "../../src/org-context";

const available = await dbAvailable();

const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe.skipIf(!available)("files lifecycle", () => {
  let owner: Sql;
  let t: TestOrg;
  const sink = new MemorySink();
  const env = syncEnv({}, sink);
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const putBytes = (actor: string, fileId: string, bytes: Uint8Array, contentType = "image/jpeg") =>
    callSync(env, syncRequest("PUT", `/sync/files/${fileId}`, { actor, org: t.org, rawBody: bytes as unknown as BodyInit, headers: { "Content-Type": contentType } }));

  const photo = new TextEncoder().encode("not really a jpeg but bytes are bytes");
  let viaPut: string;
  let viaDeclared: string;
  let liar: string;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "files");
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("POST /files creates a pending row with storage_key <org>/<id> and a Worker-mediated put_url; event file.created", async () => {
    const r = await call("POST", t.techA, "/files", { filename: "front-door.jpg", kind: "photo", content_type: "image/jpeg", project_id: t.project });
    expect(r.status).toBe(201);
    const b = r.body as { file_id: string; storage_key: string; upload_status: string; put_url: string };
    viaPut = b.file_id;
    expect(b.upload_status).toBe("pending");
    expect(b.storage_key).toBe(`${t.org}/${b.file_id}`);
    expect(b.put_url).toBe(`http://worker.test/sync/files/${b.file_id}`);
    const row = (await ownerRow(owner, "shared.files", b.file_id))!;
    expect(row.created_by).toBe(t.techA);
    expect(row.upload_status).toBe("pending");
    expect((await ownerEvents(owner, { ref_id: b.file_id, event_type: "file.created" })).length).toBe(1);
    // idempotent re-POST with the same id
    const again = await call("POST", t.techA, "/files", { id: b.file_id, filename: "front-door.jpg" });
    expect(again.status).toBe(200);
    expect((again.body as { op: string; put_url: string }).op).toBe("noop");
    expect((again.body as { put_url: string }).put_url).toBe(b.put_url);
    // validation
    expect((await call("POST", t.techA, "/files", { kind: "photo" })).status).toBe(400);
    expect((await call("POST", t.techA, "/files", { filename: "x", kind: "nope" })).status).toBe(400);
    expect((await call("POST", t.techA, "/files", { filename: "x", project_id: crypto.randomUUID() })).status).toBe(422);
  });

  it("PUT bytes: stranger 403, creator 200 → uploaded with sha256 + byte_size; R2 key = storage_key; second PUT 409; 413 over the cap", async () => {
    expect((await putBytes(t.techB, viaPut, photo)).status).toBe(403);
    const r = await putBytes(t.techA, viaPut, photo);
    expect(r.status).toBe(200);
    const b = r.body as { upload_status: string; sha256: string; byte_size: number; storage_key: string };
    expect(b.upload_status).toBe("uploaded");
    expect(b.sha256).toBe(await sha(photo));
    expect(b.byte_size).toBe(photo.byteLength);
    expect(sink.objects.has(`${t.org}/${viaPut}`)).toBe(true);
    expect(sink.objects.get(`${t.org}/${viaPut}`)!.sha256).toBe(b.sha256); // handed to R2 for header-based verify
    expect((await putBytes(t.techA, viaPut, photo)).status).toBe(409);
    const big = callSync(env, syncRequest("PUT", `/sync/files/${viaPut}`, { actor: t.techA, org: t.org, rawBody: "x", headers: { "Content-Length": String(MAX_UPLOAD_BYTES + 1) } }));
    expect((await big).status).toBe(413);
    expect((await ownerEvents(owner, { ref_id: viaPut, event_type: "file.uploaded" })).length).toBe(1);
  });

  it("POST /files/:id/uploaded: declared sha256 flips pending → uploaded (bytes already in R2 out-of-band); bad sha 400; wrong sha vs row 422", async () => {
    const declaredSha = await sha(photo);
    const c = await call("POST", t.techA, "/files", { filename: "declared.jpg", kind: "photo", sha256: declaredSha });
    viaDeclared = (c.body as { file_id: string }).file_id;
    await sink.put(`${t.org}/${viaDeclared}`, photo.buffer.slice(0) as ArrayBuffer); // bytes arrived without the Worker (no sha header → cron must digest)
    expect((await call("POST", t.techA, `/files/${viaDeclared}/uploaded`, { sha256: "zz" })).status).toBe(400);
    expect((await call("POST", t.techA, `/files/${viaDeclared}/uploaded`, { sha256: "0".repeat(64) })).status).toBe(422);
    expect((await call("POST", t.techB, `/files/${viaDeclared}/uploaded`, { sha256: declaredSha })).status).toBe(403);
    const r = await call("POST", t.techA, `/files/${viaDeclared}/uploaded`, { sha256: declaredSha, byte_size: photo.byteLength });
    expect(r.status).toBe(200);
    expect((await ownerRow(owner, "shared.files", viaDeclared))!.upload_status).toBe("uploaded");
    // idempotent
    expect(((await call("POST", t.techA, `/files/${viaDeclared}/uploaded`, { sha256: declaredSha })).body as { op: string }).op).toBe("noop");
    // and a file whose declared sha does NOT match what is in R2
    const l = await call("POST", t.techA, "/files", { filename: "liar.jpg", kind: "photo" });
    liar = (l.body as { file_id: string }).file_id;
    await sink.put(`${t.org}/${liar}`, new TextEncoder().encode("different bytes").buffer as ArrayBuffer);
    expect((await call("POST", t.techA, `/files/${liar}/uploaded`, { sha256: "a".repeat(64) })).status).toBe(200);
  });

  it("cron verify: matching sha → verified (header path and digest path), mismatch → file.verify_failed and stays uploaded; nothing deleted", async () => {
    const ctx = systemContext(env, t.org);
    const r = await verifyUploadedFiles(ctx, sink);
    expect(r.checked).toBe(3);
    expect(r.verified.sort()).toEqual([viaPut, viaDeclared].sort());
    expect(r.mismatched).toEqual([liar]);
    expect(r.missing).toEqual([]);
    expect((await ownerRow(owner, "shared.files", viaPut))!.upload_status).toBe("verified");
    expect((await ownerRow(owner, "shared.files", viaDeclared))!.upload_status).toBe("verified");
    expect((await ownerRow(owner, "shared.files", liar))!.upload_status).toBe("uploaded");
    expect((await ownerEvents(owner, { ref_id: viaPut, event_type: "file.verified" })).length).toBe(1);
    expect((await ownerEvents(owner, { ref_id: liar, event_type: "file.verify_failed" })).length).toBe(1);
    expect(sink.objects.size).toBe(3);
    // a second run re-checks only the still-'uploaded' row and emits no second verify_failed
    const r2 = await verifyUploadedFiles(ctx, sink);
    expect(r2.checked).toBe(1);
    expect((await ownerEvents(owner, { ref_id: liar, event_type: "file.verify_failed" })).length).toBe(1);
    // verified is terminal: a PUT now is 409
    expect((await putBytes(t.techA, viaPut, photo)).status).toBe(409);
  });

  it("orphan sweep: stale pending rows + R2 keys without rows → ONE files.orphan_report event per day; no row or object is deleted", async () => {
    const ctx = systemContext(env, t.org);
    // a pending row 8 days old (owner moves received_at back), a fresh pending row, and a stray R2 object
    const stale = await call("POST", t.techA, "/files", { filename: "never-uploaded.jpg", kind: "photo" });
    const staleId = (stale.body as { file_id: string }).file_id;
    await owner`update shared.files set received_at = now() - interval '8 days' where id = ${staleId}`;
    const fresh = await call("POST", t.techA, "/files", { filename: "just-now.jpg", kind: "photo" });
    const strayKey = `${t.org}/${crypto.randomUUID()}`;
    await sink.put(strayKey, new TextEncoder().encode("stray").buffer as ArrayBuffer);
    const rowsBefore = (await owner`select count(*)::int as n from shared.files where organization_id = ${t.org}`)[0].n;
    const objectsBefore = sink.objects.size;

    const rep = await orphanSweep(ctx, sink);
    expect(rep.pending_over_threshold.map((p) => p.file_id)).toEqual([staleId]);
    expect(rep.r2_without_row.map((o) => o.key)).toEqual([strayKey]);
    expect(rep.event_written).toBe(true);
    const ev = await ownerEvents(owner, { organization_id: t.org, event_type: "files.orphan_report" });
    expect(ev.length).toBe(1);
    expect(ev[0].actor_type).toBe("system");
    const payload = ev[0].payload as { pending_over_threshold: { file_id: string }[]; r2_without_row: { key: string }[] };
    expect(payload.pending_over_threshold[0].file_id).toBe(staleId);
    expect(payload.r2_without_row[0].key).toBe(strayKey);
    expect(payload.pending_over_threshold.map((p) => p.file_id)).not.toContain((fresh.body as { file_id: string }).file_id);

    // nothing deleted, nothing changed
    expect((await owner`select count(*)::int as n from shared.files where organization_id = ${t.org}`)[0].n).toBe(rowsBefore);
    expect(sink.objects.size).toBe(objectsBefore);
    expect((await ownerRow(owner, "shared.files", staleId))!.upload_status).toBe("pending");
    // same day again → the daily key makes it a no-op (still exactly one report)
    const rep2 = await orphanSweep(ctx, sink);
    expect(rep2.event_written).toBe(false);
    expect((await ownerEvents(owner, { organization_id: t.org, event_type: "files.orphan_report" })).length).toBe(1);
  });

  it("push's files[] answer agrees with the lifecycle (pending → put_url; verified → no url)", async () => {
    const p = await call("POST", t.techA, "/sync/push", { device_id: "d", rows: [], files: [{ file_id: viaPut }, { file_id: liar }] });
    const files = (p.body as { files: { file_id: string; upload_status: string; put_url?: string }[] }).files;
    expect(files.find((f) => f.file_id === viaPut)).toEqual({ file_id: viaPut, upload_status: "verified" });
    expect(files.find((f) => f.file_id === liar)).toEqual({ file_id: liar, upload_status: "uploaded" });
  });
});
