// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09
// Plan import, device-first rasters (spec §5.6, §6 check 7 API half): POST /drawing-versions · POST /pages ·
// raster_status pending → device · the /sync/push path flips it too · versions ride along in /sync/pull ·
// GET /files/:id · GET /projects/:id/history.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, syncSet, setCheckout, ownerEvents, ownerRow, ownerCount, MemorySink, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";
import type { PullResult } from "../../src/sync/pull";

const available = await dbAvailable();
const T0 = "2026-10-09T09:00:00Z";

describe.skipIf(!available)("plan import (spec §5.6)", () => {
  let owner: Sql;
  let t: TestOrg;
  const sink = new MemorySink();
  const env = syncEnv({}, sink);
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));

  let pdfPending: string, pdfLanded: string, prev1: string, prev2: string, prev1b: string, prevPending: string;
  let v2: string;

  const file = async (id: string, kind: string, status: string, name = `${kind}.bin`, ct = "image/jpeg") => {
    await owner`insert into shared.files (id, organization_id, kind, filename, content_type, storage_key, upload_status, occurred_at, created_by)
                values (${id}, ${t.org}, ${kind}, ${name}, ${ct}, ${`${t.org}/${id}`}, ${status}, ${T0}, ${t.designer})`;
  };

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "plan-import");
    pdfPending = crypto.randomUUID(); pdfLanded = crypto.randomUUID(); prev1 = crypto.randomUUID(); prev2 = crypto.randomUUID(); prev1b = crypto.randomUUID(); prevPending = crypto.randomUUID();
    await file(pdfPending, "plan_source", "pending", "set.pdf", "application/pdf");
    await file(pdfLanded, "plan_source", "uploaded", "set.pdf", "application/pdf");
    await file(prev1, "page_preview", "uploaded");
    await file(prev2, "page_preview", "verified");
    await file(prev1b, "page_preview", "verified");
    await file(prevPending, "page_preview", "pending");
    await sink.put(`${t.org}/${prev2}`, new TextEncoder().encode("JPEGBYTES").buffer, { httpMetadata: { contentType: "image/jpeg" } });
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("POST /drawing-versions: technician 403; missing fields 400; unknown drawing 404; whiteboard 409; source bytes not landed 409", async () => {
    const good = { drawing_id: t.drawing, source_file_id: pdfLanded, page_count: 2 };
    expect((await call("POST", t.techA, "/drawing-versions", good)).status).toBe(403);
    expect((await call("POST", t.designerB, "/drawing-versions", { ...good, page_count: 0 })).status).toBe(400);
    expect((await call("POST", t.designerB, "/drawing-versions", { ...good, drawing_id: "nope" })).status).toBe(400);
    expect((await call("POST", t.designerB, "/drawing-versions", { ...good, drawing_id: crypto.randomUUID() })).status).toBe(404);
    expect((await call("POST", t.designerB, "/drawing-versions", { ...good, source_file_id: crypto.randomUUID() })).status).toBe(404);
    expect((await call("POST", t.designerB, "/drawing-versions", { ...good, drawing_id: t.whiteboard })).status).toBe(409);
    const pend = await call("POST", t.designerB, "/drawing-versions", { ...good, source_file_id: pdfPending });
    expect(pend.status).toBe(409);
    expect((pend.body as { upload_status: string }).upload_status).toBe("pending");
    expect(await ownerCount(owner, "drawings.drawing_versions", { drawing_id: t.drawing })).toBe(1);
  });

  it("201: version_no = max + 1, status draft, raster_status pending, source + page_count recorded, ONE event drawing_version.created; a second import mints the next number", async () => {
    const r = await call("POST", t.designerB, "/drawing-versions", { drawing_id: t.drawing, source_file_id: pdfLanded, page_count: 2, label: "Permit set B" });
    expect(r.status).toBe(201);
    const v = (r.body as { version: Record<string, unknown> }).version;
    expect(v).toMatchObject({ drawing_id: t.drawing, version_no: 2, status: "draft", raster_status: "pending", source_file_id: pdfLanded, page_count: 2, label: "Permit set B", revision: 1, created_by: t.designerB });
    expect(v).not.toHaveProperty("organization_id");
    v2 = v.id as string;
    expect((await ownerEvents(owner, { ref_id: v2, event_type: "drawing_version.created" })).length).toBe(1);
    const r3 = await call("POST", t.office, "/drawing-versions", { drawing_id: t.drawing, source_file_id: pdfLanded, page_count: 1 });
    expect(r3.status).toBe(201);
    expect((r3.body as { version: { version_no: number } }).version.version_no).toBe(3);
  });

  it("POST /pages: 400 shape; 404 unknown version; 422 unknown preview; 400 source_page_no over page_count; technician 403", async () => {
    expect((await call("POST", t.designerB, "/pages", { drawing_version_id: v2 })).status).toBe(400);
    expect((await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 1 }] })).status).toBe(400);
    expect((await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 1, preview_file_id: prev1 }, { source_page_no: 1, preview_file_id: prev2 }] })).status).toBe(400);
    expect((await call("POST", t.designerB, "/pages", { drawing_version_id: crypto.randomUUID(), pages: [{ source_page_no: 1, preview_file_id: prev1 }] })).status).toBe(404);
    const unk = await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 1, preview_file_id: crypto.randomUUID() }] });
    expect(unk.status).toBe(422);
    expect((await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 3, preview_file_id: prev1 }] })).status).toBe(400);
    expect((await call("POST", t.techA, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 1, preview_file_id: prev1 }] })).status).toBe(403);
    expect(await ownerCount(owner, "drawings.pages", { drawing_version_id: v2 })).toBe(0);
  });

  it("one of two pages → raster_status stays pending; a page whose preview is still pending does not count; all landed → 'device' + event; re-POST updates the same page (idempotent by source_page_no)", async () => {
    const r1 = await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 1, name: "Floor 1", orientation: "portrait", preview_file_id: prev1 }] });
    expect(r1.status).toBe(200);
    const b1 = r1.body as { pages: Record<string, unknown>[]; raster_status: string; previews_landed: number };
    expect(b1.raster_status).toBe("pending");
    expect(b1.previews_landed).toBe(1);
    expect(b1.pages[0]).toMatchObject({ drawing_id: t.drawing, drawing_version_id: v2, source_page_no: 1, ordinal: 1, name: "Floor 1", orientation: "portrait", preview_file_id: prev1, preview_upload_status: "uploaded", revision: 1, op: "created" });
    const p1 = b1.pages[0].id as string;
    expect((await ownerEvents(owner, { ref_id: p1, event_type: "drawing_page.recorded" })).length).toBe(1);

    // page 2 with a PENDING preview: recorded, but the raster is not complete
    const r2 = await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 2, preview_file_id: prevPending }] });
    expect(r2.status).toBe(200);
    expect((r2.body as { raster_status: string }).raster_status).toBe("pending");
    expect((await ownerRow(owner, "drawings.drawing_versions", v2))!.raster_status).toBe("pending");

    // page 2 re-posted with a landed preview → the same page row is updated, raster flips to device
    const r3 = await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 2, preview_file_id: prev2 }] });
    expect(r3.status).toBe(200);
    const b3 = r3.body as { pages: Record<string, unknown>[]; raster_status: string };
    expect(b3.raster_status).toBe("device");
    expect(b3.pages[0]).toMatchObject({ source_page_no: 2, preview_file_id: prev2, revision: 2, op: "updated" });
    expect(await ownerCount(owner, "drawings.pages", { drawing_version_id: v2 })).toBe(2);
    expect((await ownerRow(owner, "drawings.drawing_versions", v2))!.raster_status).toBe("device");
    expect((await ownerEvents(owner, { ref_id: v2, event_type: "drawing_version.rasterized" })).length).toBe(1);

    // page 1 re-posted with a new preview: still 2 pages, revision 3? no — page 1 is at revision 1 → 2
    const r4 = await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 1, preview_file_id: prev1b }] });
    expect((r4.body as { pages: Record<string, unknown>[] }).pages[0]).toMatchObject({ id: p1, preview_file_id: prev1b, revision: 2, op: "updated" });
    expect(await ownerCount(owner, "drawings.pages", { drawing_version_id: v2 })).toBe(2);
    expect((await ownerRow(owner, "drawings.pages", p1))!.name).toBe("Floor 1"); // name kept when omitted
  });

  it("raster_status is monotone: 'verified' (the reserved rasterizer) is never downgraded by a page re-post; 'device' never returns to pending", async () => {
    await owner`update drawings.drawing_versions set raster_status = 'verified' where id = ${v2}`;
    const r = await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 1, preview_file_id: prevPending }] });
    expect(r.status).toBe(200);
    expect((r.body as { raster_status: string }).raster_status).toBe("verified");
    await owner`update drawings.drawing_versions set raster_status = 'device' where id = ${v2}`;
    const r2 = await call("POST", t.designerB, "/pages", { drawing_version_id: v2, pages: [{ source_page_no: 2, preview_file_id: prevPending }] });
    expect((r2.body as { raster_status: string }).raster_status).toBe("device");
    await owner`update drawings.drawing_versions set raster_status = 'device' where id = ${v2}`;
  });

  it("/sync/push of drawings.pages (the offline path) refreshes raster_status the same way (`raster_status[]` in the push result)", async () => {
    const v3 = (await owner<{ id: string }[]>`select id from drawings.drawing_versions where drawing_id = ${t.drawing} and version_no = 3`)[0].id;
    await setCheckout(owner, t, t.designer); // pages of an attached drawing are structure rows → the checkout holder pushes them
    const page = syncSet(t, t.designer, { drawing_id: t.drawing, drawing_version_id: v3, ordinal: 1, name: "Only page", orientation: "landscape", preview_file_id: prev2, source_page_no: 1, custom: {} });
    const r = (await call("POST", t.designer, "/sync/push", { device_id: "ipad-1", rows: [{ table: "drawings.pages", row: page }] })).body as PushResult;
    expect(r.rejected).toEqual([]);
    expect(r.raster_status).toEqual([expect.objectContaining({ version_id: v3, raster_status: "device", page_count: 1, landed: 1, changed: true })]);
    expect((await ownerRow(owner, "drawings.drawing_versions", v3))!.raster_status).toBe("device");
    await setCheckout(owner, t, null);
  });

  it("/sync/pull carries drawings.drawing_versions (read-only) for the project's drawings", async () => {
    const r = await call("GET", t.techA, `/sync/pull?project_id=${t.project}`);
    expect(r.status).toBe(200);
    const b = r.body as PullResult;
    const versions = b.structure["drawings.drawing_versions"];
    expect(versions.map((v) => v.version_no).sort()).toEqual([1, 2, 3]);
    expect(versions.find((v) => v.id === v2)).toMatchObject({ status: "draft", raster_status: "device", page_count: 2 });
  });

  it("GET /files/:id streams a landed file's bytes with its Content-Type; a pending row or unknown id → 404; bad id → 400", async () => {
    const r = await call("GET", t.techA, `/files/${prev2}`);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(r.body as ArrayBuffer)).toBe("JPEGBYTES");
    expect(r.headers?.["Content-Disposition"]).toContain("page_preview.bin");
    expect((await call("GET", t.techA, `/files/${prevPending}`)).status).toBe(404);
    expect((await call("GET", t.techA, `/files/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("GET", t.techA, `/files/not-a-uuid`)).status).toBe(400);
    // a row whose bytes never reached storage
    expect((await call("GET", t.techA, `/files/${prev1}`)).status).toBe(404);
  });

  it("GET /projects/:id/history: newest first, events for the project and its drawings; since / limit; 404 unknown project", async () => {
    expect((await call("GET", t.techA, `/projects/${crypto.randomUUID()}/history`)).status).toBe(404);
    expect((await call("GET", t.techA, `/projects/${t.project}/history?limit=0`)).status).toBe(400);
    expect((await call("GET", t.techA, `/projects/${t.project}/history?since=yesterday`)).status).toBe(400);
    const r = await call("GET", t.techA, `/projects/${t.project}/history`);
    expect(r.status).toBe(200);
    const b = r.body as { events: { id: string; kind: string; occurred_at: string; ref_table: string; ref_id: string | null; actor_id: string | null }[]; next_since: string; truncated: boolean };
    const kinds = b.events.map((e) => e.kind);
    expect(kinds).toContain("drawing_version.created");
    expect(kinds).toContain("drawing_version.rasterized");
    expect(kinds).toContain("drawing_page.recorded");
    for (let i = 1; i < b.events.length; i++) expect(b.events[i - 1].occurred_at >= b.events[i].occurred_at).toBe(true);
    expect(b.events[0]).toHaveProperty("actor_id");
    expect(b.events[0]).toHaveProperty("ref_table");
    const lim = (await call("GET", t.techA, `/projects/${t.project}/history?limit=2`)).body as { events: unknown[]; truncated: boolean };
    expect(lim.events.length).toBe(2);
    expect(lim.truncated).toBe(true);
    const none = (await call("GET", t.techA, `/projects/${t.project}/history?since=${encodeURIComponent(b.next_since)}`)).body as { events: unknown[] };
    expect(none.events).toEqual([]);
  });
});
