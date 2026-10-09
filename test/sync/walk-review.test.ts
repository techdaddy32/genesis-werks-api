// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09
// Walk review link (spec §5.8, §6 check 9): POST /walks/:id/export (snapshot inline, token ≥ 32) · GET /walk/:token
// (login-gated HTML, 404 / 403 / 410) · POST /walk/:token/reply · POST /walks/:id/pull-replies (ADD-ONLY: matched →
// location_notes(kind='reply'), a typo'd entry id → action_items(walk_reply) via field_rules, app text unchanged, idempotent).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, ownerEvents, ownerRow, ownerCount, MemorySink, type Sql, type TestOrg } from "./_db";
import { mintShareToken, escapeHtml, type WalkSnapshot } from "../../src/sync/walk-review";

const available = await dbAvailable();
const T = (m: number) => new Date(Date.parse("2026-10-09T08:00:00Z") + m * 60_000).toISOString();

interface ExportBody { op: string; export_id: string; walk_id: string; share_token: string; url: string; expires_at: string; counts: Record<string, number> }
interface ReplyBody { reply_id: string; entry_table: string; replied_by: string | null; checked: boolean; received_at: string }
interface PullBody { merged: number; unmatched: number; skipped: number; merged_rows: { reply_id: string; note_id: string; entry_id: string }[]; unmatched_rows: { reply_id: string; action_item_id: string | null }[] }

describe.skipIf(!available)("walk review link (spec §5.8)", () => {
  let owner: Sql;
  let t: TestOrg;
  let other: TestOrg;
  const sink = new MemorySink();
  const env = syncEnv({}, sink);
  const call = (method: string, actor: string, path: string, body?: unknown, org?: string) => callSync(env, syncRequest(method, path, { actor, org: org ?? t.org, ...(body !== undefined ? { body } : {}) }));

  let walk: string, noteKitchen: string, noteFoyer: string, noteBonus: string, mediaKitchen: string, mediaInternal: string, placementFoyer: string;
  let photo: string, preview: string, sketch: string;
  let exp: ExportBody;
  let replyMatched: string, replyMedia: string, replyTypo: string, replyChecked: string;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "walk-review");
    other = await createTestOrg(owner, "walk-review-other");
    walk = crypto.randomUUID(); noteKitchen = crypto.randomUUID(); noteFoyer = crypto.randomUUID(); noteBonus = crypto.randomUUID();
    mediaKitchen = crypto.randomUUID(); mediaInternal = crypto.randomUUID(); placementFoyer = crypto.randomUUID();
    photo = crypto.randomUUID(); preview = crypto.randomUUID(); sketch = crypto.randomUUID();
    await owner`insert into places.walks (id, organization_id, account_id, project_id, status, label, address_hint, started_at, attached_at, attached_by, occurred_at, created_by, device_id)
                values (${walk}, ${t.org}, ${t.account}, ${t.project}, 'attached', 'Rough-in walk', '1 Example Ct', ${T(0)}, ${T(0)}, ${t.techA}, ${T(0)}, ${t.techA}, 'phone-a')`;
    await owner`insert into shared.files (id, organization_id, kind, filename, content_type, storage_key, upload_status, walk_id, occurred_at, created_by) values
      (${photo},   ${t.org}, 'photo',        'island.jpg', 'image/jpeg', ${`${t.org}/${photo}`},   'verified', ${walk}, ${T(0)}, ${t.techA}),
      (${preview}, ${t.org}, 'page_preview', 'sketch.png', 'image/png',  ${`${t.org}/${preview}`}, 'uploaded', ${walk}, ${T(0)}, ${t.techA})`;
    await sink.put(`${t.org}/${preview}`, new TextEncoder().encode("PNG").buffer, { httpMetadata: { contentType: "image/png" } });
    // walk order: Foyer first (08:01), Kitchen second (08:05), then a hinted "Bonus Rm" (08:09)
    await owner`insert into places.location_notes (id, organization_id, account_id, project_id, room_id, room_hint, location_id, kind, phase, body, walk_id, occurred_at, created_by) values
      (${noteFoyer},   ${t.org}, ${t.account}, ${t.project}, ${t.rooms.foyer},   null, null, 'note', 'rough', 'Keypad left of door <b>not</b> right', ${walk}, ${T(1)}, ${t.techA}),
      (${noteKitchen}, ${t.org}, ${t.account}, ${t.project}, ${t.rooms.kitchen}, null, ${t.locationTv}, 'flag', 'rough', 'Island outlets missing', ${walk}, ${T(5)}, ${t.techA}),
      (${noteBonus},   ${t.org}, ${t.account}, ${t.project}, null, 'Bonus Rm', null, 'measurement', null, '14ft 6in wall', ${walk}, ${T(9)}, ${t.techA})`;
    await owner`insert into places.location_media (id, organization_id, account_id, project_id, room_id, file_id, caption, internal, walk_id, occurred_at, created_by) values
      (${mediaKitchen},  ${t.org}, ${t.account}, ${t.project}, ${t.rooms.kitchen}, ${photo}, 'island from the south', false, ${walk}, ${T(6)}, ${t.techA}),
      (${mediaInternal}, ${t.org}, ${t.account}, ${t.project}, ${t.rooms.kitchen}, ${photo}, 'INTERNAL ONLY',          true,  ${walk}, ${T(7)}, ${t.techA})`;
    await owner`insert into places.device_placements (id, organization_id, account_id, project_id, room_id, capture_kind, product_name, placement_status, walk_id, occurred_at, created_by)
                values (${placementFoyer}, ${t.org}, ${t.account}, ${t.project}, ${t.rooms.foyer}, 'as_walked', 'Keypad 7in', 'placed', ${walk}, ${T(2)}, ${t.techA})`;
    await owner`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, name, preview_file_id, room_id, walk_id, occurred_at, created_by)
                values (${sketch}, ${t.org}, ${t.whiteboard}, null, 2, 'Kitchen sketch', ${preview}, ${t.rooms.kitchen}, ${walk}, ${T(8)}, ${t.techA})`;
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("mintShareToken: ≥ 32 url-safe chars, unique; escapeHtml escapes the five", () => {
    const a = mintShareToken(), b = mintShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(escapeHtml(`<a href="x">it's & done</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; done&lt;/a&gt;");
  });

  it("POST /walks/:id/export: technician who is not the creator 403; bad expires 400; unknown walk 404; creator → 201 with token / url / expires ≈ 30 days; snapshot inline (rooms in walk order, internal media excluded, sketch page with preview)", async () => {
    expect((await call("POST", t.techB, `/walks/${walk}/export`)).status).toBe(403);
    expect((await call("POST", t.techA, `/walks/${walk}/export`, { expires_in_days: 0 })).status).toBe(400);
    expect((await call("POST", t.techA, `/walks/${walk}/export`, { expires_in_days: 400 })).status).toBe(400);
    expect((await call("POST", t.techA, `/walks/${crypto.randomUUID()}/export`)).status).toBe(404);
    const r = await call("POST", t.techA, `/walks/${walk}/export`);
    expect(r.status).toBe(201);
    exp = r.body as ExportBody;
    expect(exp.share_token.length).toBeGreaterThanOrEqual(32);
    expect(exp.url).toBe(`/walk/${exp.share_token}`);
    const days = (Date.parse(exp.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(exp.counts).toEqual({ rooms: 3, notes: 3, media: 1, placements: 1, sketches: 1 });
    const row = (await ownerRow(owner, "places.walk_exports", exp.export_id))!;
    expect(row).toMatchObject({ walk_id: walk, project_id: t.project, snapshot_file_id: null, created_by: t.techA, share_token: exp.share_token });
    const snap = row.snapshot as WalkSnapshot;
    expect(snap.walk).toMatchObject({ id: walk, label: "Rough-in walk", project_name: "Test House — 1 Example Ct", account_name: "Example Homeowner (test)", created_by_name: "Test Tech A" });
    expect(snap.rooms.map((r) => r.name)).toEqual(["Foyer", "Kitchen", "Bonus Rm"]);
    expect(snap.rooms[0].entries.map((e) => [e.table, e.id])).toEqual([["places.location_notes", noteFoyer], ["places.device_placements", placementFoyer]]);
    const kitchen = snap.rooms[1];
    expect(kitchen.entries.map((e) => e.id)).toEqual([noteKitchen, mediaKitchen]); // the internal one is not here
    expect(kitchen.entries[0]).toMatchObject({ kind: "flag", location: "Kitchen TV", by: "Test Tech A", phase: "rough" });
    expect(kitchen.entries[1]).toMatchObject({ kind: "photo", file_id: photo, file_status: "verified", content_type: "image/jpeg", text: "island from the south" });
    expect(kitchen.sketches).toEqual([{ page_id: sketch, drawing_id: t.whiteboard, name: "Kitchen sketch", preview_file_id: preview, preview_status: "uploaded", ordinal: 2 }]);
    expect((await ownerEvents(owner, { ref_id: exp.export_id, event_type: "walk.exported" })).length).toBe(1);
    // office may export too (a second link, its own token)
    const r2 = await call("POST", t.office, `/walks/${walk}/export`, { expires_in_days: 7 });
    expect(r2.status).toBe(201);
    expect((r2.body as ExportBody).share_token).not.toBe(exp.share_token);
  });

  it("GET /walk/:token: any member of the org → 200 text/html with one collapsed card per room, entry ids, the photo and sketch <img> via /files/:id, a reply form per entry, no external scripts", async () => {
    const r = await call("GET", t.techB, exp.url);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/html; charset=utf-8");
    const html = r.body as string;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Rough-in walk — walk review</title>");
    expect((html.match(/<details class="room"/g) ?? []).length).toBe(3);
    expect(html).not.toContain("<details class=\"room\" open");
    expect(html.indexOf("<h2>Foyer</h2>")).toBeLessThan(html.indexOf("<h2>Kitchen</h2>"));
    expect(html.indexOf("<h2>Kitchen</h2>")).toBeLessThan(html.indexOf("<h2>Bonus Rm</h2>"));
    for (const id of [noteFoyer, noteKitchen, noteBonus, mediaKitchen, placementFoyer]) {
      expect(html).toContain(`id="e-${id}"`);
      expect(html).toContain(`<form class="rb noprint" data-entry="${id}"`);
    }
    expect(html).not.toContain(mediaInternal);
    expect(html).not.toContain("INTERNAL ONLY");
    expect(html).toContain(`src="/files/${photo}"`);
    expect(html).toContain(`src="/files/${preview}"`);
    expect(html).toContain("Keypad left of door &lt;b&gt;not&lt;/b&gt; right"); // escaped, never raw
    expect(html).not.toContain("<b>not</b>");
    expect(html).toContain(`data-reply-url="/walk/${exp.share_token}/reply"`);
    expect(html).toContain(`data-actor="${t.techB}"`);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).toContain("@media print");
    // the sketch bytes are reachable from the page's own origin
    expect((await call("GET", t.techB, `/files/${preview}`)).contentType).toBe("image/png");
  });

  it("gate: no credential 401; a member of ANOTHER org 403 (org-context); that org's context sees no such token 404; unknown token 404; expired 410; revoked 410", async () => {
    expect((await callSync(env, syncRequest("GET", exp.url, { org: t.org }))).status).toBe(401);
    expect((await call("GET", other.techA, exp.url)).status).toBe(403);
    const cross = await call("GET", other.techA, exp.url, undefined, other.org);
    expect(cross.status).toBe(404);
    expect(cross.contentType).toContain("text/html");
    expect((await call("GET", t.techB, `/walk/${mintShareToken()}`)).status).toBe(404);
    expect((await call("GET", t.techB, `/walk/short`)).status).toBe(404);
    await owner`update places.walk_exports set expires_at = now() - interval '1 minute' where id = ${exp.export_id}`;
    const gone = await call("GET", t.techB, exp.url);
    expect(gone.status).toBe(410);
    expect(gone.body as string).toContain("expired");
    expect((await call("POST", t.techB, `${exp.url}/reply`, { entry_id: noteFoyer, reply: "late" })).status).toBe(410);
    await owner`update places.walk_exports set expires_at = now() + interval '30 days', revoked_at = now() where id = ${exp.export_id}`;
    expect((await call("GET", t.techB, exp.url)).status).toBe(410);
    await owner`update places.walk_exports set revoked_at = null where id = ${exp.export_id}`;
    expect((await call("GET", t.techB, exp.url)).status).toBe(200);
  });

  it("POST /walk/:token/reply: 400 without text or checked; 400 bad entry id; 201 — entry_table from the snapshot, replied_by defaults to the member; a typo'd entry id is still accepted; the page shows the latest reply", async () => {
    expect((await call("POST", t.office, `${exp.url}/reply`, { entry_id: noteKitchen })).status).toBe(400);
    expect((await call("POST", t.office, `${exp.url}/reply`, { entry_id: "nope", reply: "x" })).status).toBe(400);
    expect((await call("POST", t.office, `${exp.url}/reply`, { entry_id: noteKitchen, reply: "x", entry_table: "places.rooms" })).status).toBe(400);
    const r1 = await call("POST", t.office, `${exp.url}/reply`, { entry_id: noteKitchen, reply: "Added 2 GFCI on the island — see RFI 4" });
    expect(r1.status).toBe(201);
    const b1 = r1.body as ReplyBody;
    expect(b1).toMatchObject({ entry_table: "places.location_notes", replied_by: "Test Office", checked: false });
    replyMatched = b1.reply_id;
    const r2 = await call("POST", t.office, `${exp.url}/reply`, { entry_id: mediaKitchen, reply: "good angle", checked: true, replied_by: "Jane (homeowner)" });
    expect((r2.body as ReplyBody)).toMatchObject({ entry_table: "places.location_media", replied_by: "Jane (homeowner)", checked: true });
    replyMedia = (r2.body as ReplyBody).reply_id;
    // check 9: a typo'd entry id — a valid UUID that is nothing in this walk
    const typo = crypto.randomUUID();
    const r3 = await call("POST", t.designerB, `${exp.url}/reply`, { entry_id: typo, reply: "which keypad?" });
    expect(r3.status).toBe(201);
    expect((r3.body as ReplyBody).entry_table).toBe("places.location_notes"); // the default when the snapshot has no such entry
    replyTypo = (r3.body as ReplyBody).reply_id;
    const r4 = await call("POST", t.office, `${exp.url}/reply`, { entry_id: placementFoyer, checked: true });
    expect(r4.status).toBe(201);
    expect((r4.body as ReplyBody).entry_table).toBe("places.device_placements");
    replyChecked = (r4.body as ReplyBody).reply_id;
    // a second reply on the same entry: the page shows the LATEST
    await call("POST", t.office, `${exp.url}/reply`, { entry_id: noteKitchen, reply: "correction: 3 GFCI" });
    const html = (await call("GET", t.techB, exp.url)).body as string;
    expect(html).toContain("correction: 3 GFCI");
    expect(html).not.toContain("see RFI 4");
    expect(html).toContain("Jane (homeowner)");
    expect(await ownerCount(owner, "places.walk_replies", { export_id: exp.export_id })).toBe(5);
    expect((await ownerEvents(owner, { ref_id: replyMatched, event_type: "walk.reply_received" })).length).toBe(1);
  });

  it("POST /walks/:id/pull-replies (check 9): matched → location_notes(kind='reply') under the same room / location; typo → action_items(walk_reply) via the seeded rule; originals untouched; 403 for a non-creator technician", async () => {
    expect((await call("POST", t.techB, `/walks/${walk}/pull-replies`)).status).toBe(403);
    const before = (await ownerRow(owner, "places.location_notes", noteKitchen))!;
    const r = await call("POST", t.techA, `/walks/${walk}/pull-replies`);
    expect(r.status).toBe(200);
    const b = r.body as PullBody;
    expect(b).toMatchObject({ merged: 4, unmatched: 1, skipped: 0 });
    // the matched note reply
    const m = b.merged_rows.find((x) => x.reply_id === replyMatched)!;
    const note = (await ownerRow(owner, "places.location_notes", m.note_id))!;
    expect(note).toMatchObject({ kind: "reply", body: "Added 2 GFCI on the island — see RFI 4", room_id: t.rooms.kitchen, location_id: t.locationTv, project_id: t.project, account_id: t.account, walk_id: walk, note_layer: "office", phase: "rough", created_by: t.techA, revision: 1 });
    expect(note.custom).toMatchObject({ walk_reply_id: replyMatched, replied_by: "Test Office", checked: false, reply_to_table: "places.location_notes", reply_to_id: noteKitchen });
    // the media reply lands as a note too (checked travels in custom)
    const mm = b.merged_rows.find((x) => x.reply_id === replyMedia)!;
    expect((await ownerRow(owner, "places.location_notes", mm.note_id))!).toMatchObject({ kind: "reply", body: "good angle", room_id: t.rooms.kitchen });
    expect(((await ownerRow(owner, "places.location_notes", mm.note_id))!.custom as { checked: boolean }).checked).toBe(true);
    // checked-only reply on a placement → a '[checked]' note
    const mc = b.merged_rows.find((x) => x.reply_id === replyChecked)!;
    expect((await ownerRow(owner, "places.location_notes", mc.note_id))!).toMatchObject({ kind: "reply", body: "[checked]", room_id: t.rooms.foyer });
    // NO app text changed
    const after = (await ownerRow(owner, "places.location_notes", noteKitchen))!;
    expect(after.body).toBe(before.body);
    expect(after.revision).toBe(before.revision);
    expect(after.kind).toBe("flag");
    expect(after.updated_at).toEqual(before.updated_at);
    expect((await ownerRow(owner, "places.location_media", mediaKitchen))!.caption).toBe("island from the south");
    // the typo → an action item from the seeded field rule
    const u = b.unmatched_rows[0];
    expect(u.reply_id).toBe(replyTypo);
    expect(u.action_item_id).not.toBeNull();
    const item = (await ownerRow(owner, "shared.action_items", u.action_item_id!))!;
    expect(item).toMatchObject({ source_kind: "walk_reply", source_ref_table: "places.walk_replies", source_ref_id: replyTypo, project_id: t.project, status: "open", title: "Unmatched review reply from Test Designer B", description: "which keypad?" });
    expect(item.rule_id).not.toBeNull();
    // bookkeeping on the replies
    expect((await ownerRow(owner, "places.walk_replies", replyMatched))!).toMatchObject({ merge_outcome: "matched", merged_note_id: m.note_id });
    expect((await ownerRow(owner, "places.walk_replies", replyMatched))!.merged_at).toBeInstanceOf(Date);
    expect((await ownerRow(owner, "places.walk_replies", replyTypo))!).toMatchObject({ merge_outcome: "unmatched", merged_note_id: null });
    expect((await ownerEvents(owner, { ref_id: replyTypo, event_type: "walk_reply.unmatched" })).length).toBe(1);
    expect((await ownerEvents(owner, { ref_id: walk, event_type: "walk.replies_pulled" })).length).toBe(1);
    expect(await ownerCount(owner, "places.location_notes", { walk_id: walk, kind: "reply" })).toBe(4);
  });

  it("pull is idempotent: a re-run merges nothing (skipped = all); a reply received later merges on the next pull; a reply on a tombstoned entry is unmatched; the page marks merged replies", async () => {
    const again = (await call("POST", t.designer, `/walks/${walk}/pull-replies`)).body as PullBody;
    expect(again).toMatchObject({ merged: 0, unmatched: 0, skipped: 5 });
    expect(await ownerCount(owner, "places.location_notes", { walk_id: walk, kind: "reply" })).toBe(4);
    expect(await ownerCount(owner, "shared.action_items", { source_kind: "walk_reply", organization_id: t.org })).toBe(1);
    // later replies: one matched (bonus room — hinted, no room_id), one on an entry tombstoned since the export
    await owner`update places.location_notes set deleted_at = now(), deleted_by = ${t.techA} where id = ${noteFoyer}`;
    await call("POST", t.office, `${exp.url}/reply`, { entry_id: noteBonus, reply: "confirmed 14'6\"" });
    await call("POST", t.office, `${exp.url}/reply`, { entry_id: noteFoyer, reply: "too late" });
    const next = (await call("POST", t.designer, `/walks/${walk}/pull-replies`)).body as PullBody;
    expect(next).toMatchObject({ merged: 1, unmatched: 1, skipped: 5 });
    const bonusNote = (await ownerRow(owner, "places.location_notes", next.merged_rows[0].note_id))!;
    expect(bonusNote).toMatchObject({ kind: "reply", room_id: null, room_hint: "Bonus Rm", body: "confirmed 14'6\"" });
    expect(await ownerCount(owner, "shared.action_items", { source_kind: "walk_reply", organization_id: t.org })).toBe(2);
    const html = (await call("GET", t.techB, exp.url)).body as string;
    expect(html).toContain(", merged): good angle");
  });
});
