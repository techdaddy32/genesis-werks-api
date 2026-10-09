// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09
// Carry-forward between versions (spec §2b Amendment 2): page pairing by source_page_no (fallback ordinal),
// copied_from_id / revision 1 / created_by, idempotent re-run, layer_ids + include filters, the checkout gate
// for structure rows on an attached drawing (409 / 403) and the structure_changes proposals they land as.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, setCheckout, ownerEvents, ownerRow, ownerCount, type Sql, type TestOrg } from "./_db";
import { pairPages } from "../../src/sync/carry-forward";

const available = await dbAvailable();
const T0 = "2026-10-09T10:00:00Z";

interface CarryBody {
  op: string;
  copied: { annotations: number; polygons: number; placements: number };
  skipped: { total: number; already_copied: number; no_target_page: number; layer_missing: number };
  proposals: number;
  proposal_ids: string[];
  pages: Record<string, string>;
  ids: Record<string, string>;
}

describe.skipIf(!available)("POST /drawing-versions/:id/carry-forward", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const carry = (actor: string, to: string, body: Record<string, unknown>) => call("POST", actor, `/drawing-versions/${to}/carry-forward`, body);

  // an UNATTACHED plan drawing: v1 (3 pages) → v2 (2 pages; page 3 has no partner)
  let free: string, fv1: string, fv2: string, fLayerS: string, fLayerC: string;
  let fp1: string, fp2: string, fp3: string, fq1: string, fq2: string;
  let annS: string, annC: string, annC3: string, poly1: string, pin1: string;
  // the fixture's ATTACHED drawing: t.version (page1 / page2) → v2 (2 pages)
  let av2: string, ap1: string, ap2: string, aAnnS: string, aAnnC: string, aPoly: string, aPin: string;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "carry");
    free = crypto.randomUUID(); fv1 = crypto.randomUUID(); fv2 = crypto.randomUUID(); fLayerS = crypto.randomUUID(); fLayerC = crypto.randomUUID();
    fp1 = crypto.randomUUID(); fp2 = crypto.randomUUID(); fp3 = crypto.randomUUID(); fq1 = crypto.randomUUID(); fq2 = crypto.randomUUID();
    annS = crypto.randomUUID(); annC = crypto.randomUUID(); annC3 = crypto.randomUUID(); poly1 = crypto.randomUUID(); pin1 = crypto.randomUUID();
    await owner`insert into drawings.drawings (id, organization_id, kind, working_title, occurred_at, created_by) values (${free}, ${t.org}, 'plan', 'free plan', ${T0}, ${t.designer})`;
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, page_count, occurred_at, created_by) values
      (${fv1}, ${t.org}, ${free}, 1, 3, ${T0}, ${t.designer}), (${fv2}, ${t.org}, ${free}, 2, 2, ${T0}, ${t.designer})`;
    await owner`insert into drawings.layers (id, organization_id, drawing_id, name, ordinal, class, write_policy, export, occurred_at, created_by) values
      (${fLayerS}, ${t.org}, ${free}, 'Design', 1, 'structure', 'designer_checkout', true, ${T0}, ${t.designer}),
      (${fLayerC}, ${t.org}, ${free}, 'Field Notes', 2, 'capture', 'any_member', true, ${T0}, ${t.designer})`;
    await owner`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, source_page_no, occurred_at, created_by) values
      (${fp1}, ${t.org}, ${free}, ${fv1}, 1, 1, ${T0}, ${t.designer}), (${fp2}, ${t.org}, ${free}, ${fv1}, 2, 2, ${T0}, ${t.designer}), (${fp3}, ${t.org}, ${free}, ${fv1}, 3, 3, ${T0}, ${t.designer}),
      (${fq1}, ${t.org}, ${free}, ${fv2}, 1, 1, ${T0}, ${t.designer}), (${fq2}, ${t.org}, ${free}, ${fv2}, 2, 2, ${T0}, ${t.designer})`;
    await owner`insert into drawings.annotations (id, organization_id, page_id, layer_id, kind, class, geometry, style, label, z, room_hint, checked, custom, occurred_at, created_by) values
      (${annS},  ${t.org}, ${fp1}, ${fLayerS}, 'rect',    'structure', '{"x":1,"y":2,"w":3,"h":4}', '{"stroke":"#000"}', 'closet', 3, 'Primary', false, '{"k":1}', ${T0}, ${t.designer}),
      (${annC},  ${t.org}, ${fp2}, ${fLayerC}, 'callout', 'capture',   '{"x":5,"y":5}', null, 'c1', 1, null, true, '{}', ${T0}, ${t.techA}),
      (${annC3}, ${t.org}, ${fp3}, ${fLayerC}, 'note',    'capture',   '{"x":9,"y":9}', null, 'on page 3', 1, null, false, '{}', ${T0}, ${t.techA})`;
    await owner`insert into places.room_polygons (id, organization_id, drawing_id, drawing_version_id, page_id, room_hint, polygon, metadata, occurred_at, created_by)
                values (${poly1}, ${t.org}, ${free}, ${fv1}, ${fp1}, 'Primary', '{"points":[[0,0],[1,0],[1,1]]}', '{"level":"1"}', ${T0}, ${t.designer})`;
    await owner`insert into places.location_placements (id, organization_id, drawing_id, drawing_version_id, page_id, location_hint, room_hint, x, y, rotation, symbol_key, label_text, occurred_at, created_by)
                values (${pin1}, ${t.org}, ${free}, ${fv1}, ${fp2}, 'Primary TV', 'Primary', 12.5, 40, 90, 'tv', 'TV', ${T0}, ${t.designer})`;

    // attached drawing (t.drawing / t.project): structure + capture annotations, a polygon and a pin on page1; v2 with 2 pages
    av2 = crypto.randomUUID(); ap1 = crypto.randomUUID(); ap2 = crypto.randomUUID(); aAnnS = crypto.randomUUID(); aAnnC = crypto.randomUUID(); aPoly = crypto.randomUUID(); aPin = crypto.randomUUID();
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, page_count, occurred_at, created_by) values (${av2}, ${t.org}, ${t.drawing}, 2, 2, ${T0}, ${t.designer})`;
    await owner`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, source_page_no, occurred_at, created_by) values
      (${ap1}, ${t.org}, ${t.drawing}, ${av2}, 1, 1, ${T0}, ${t.designer}), (${ap2}, ${t.org}, ${t.drawing}, ${av2}, 2, 2, ${T0}, ${t.designer})`;
    await owner`insert into drawings.annotations (id, organization_id, page_id, layer_id, kind, class, geometry, label, z, room_id, occurred_at, created_by) values
      (${aAnnS}, ${t.org}, ${t.page1}, ${t.layerDesign},     'line',    'structure', '{"x1":0,"y1":0,"x2":9,"y2":9}', 'run', 1, ${t.rooms.kitchen}, ${T0}, ${t.designer}),
      (${aAnnC}, ${t.org}, ${t.page1}, ${t.layerFieldNotes}, 'callout', 'capture',   '{"x":5,"y":5}', 'field', 1, ${t.rooms.kitchen}, ${T0}, ${t.techA})`;
    await owner`insert into places.room_polygons (id, organization_id, account_id, project_id, drawing_id, drawing_version_id, page_id, room_id, polygon, metadata, occurred_at, created_by)
                values (${aPoly}, ${t.org}, ${t.account}, ${t.project}, ${t.drawing}, ${t.version}, ${t.page1}, ${t.rooms.kitchen}, '{"points":[[0,0],[10,0],[10,10]]}', '{}', ${T0}, ${t.designer})`;
    await owner`insert into places.location_placements (id, organization_id, account_id, project_id, drawing_id, drawing_version_id, page_id, location_id, room_id, x, y, rotation, symbol_key, label_text, occurred_at, created_by)
                values (${aPin}, ${t.org}, ${t.account}, ${t.project}, ${t.drawing}, ${t.version}, ${t.page1}, ${t.locationTv}, ${t.rooms.kitchen}, 5, 5, 0, 'tv', 'TV', ${T0}, ${t.designer})`;
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("pairPages (pure): source_page_no first, ordinal as the fallback, unmatched pages dropped", () => {
    const m = pairPages(
      [{ id: "s1", source_page_no: 1, ordinal: 1 }, { id: "s2", source_page_no: 2, ordinal: 2 }, { id: "s3", source_page_no: null, ordinal: 3 }, { id: "s4", source_page_no: 9, ordinal: 4 }],
      [{ id: "t1", source_page_no: 1, ordinal: 5 }, { id: "t2", source_page_no: 2, ordinal: 2 }, { id: "t3", source_page_no: null, ordinal: 3 }],
    );
    expect([...m.entries()]).toEqual([["s1", "t1"], ["s2", "t2"], ["s3", "t3"]]);
  });

  it("guards: technician 403; missing / bad body 400; same version 409; unknown versions 404; different drawings 409; target without pages 409; whiteboard 409", async () => {
    expect((await carry(t.techA, fv2, { from_version_id: fv1 })).status).toBe(403);
    expect((await carry(t.designerB, fv2, {})).status).toBe(400);
    expect((await carry(t.designerB, fv2, { from_version_id: fv1, include: ["pins"] })).status).toBe(400);
    expect((await carry(t.designerB, fv2, { from_version_id: fv1, layer_ids: ["x"] })).status).toBe(400);
    expect((await carry(t.designerB, fv2, { from_version_id: fv2 })).status).toBe(409);
    expect((await carry(t.designerB, crypto.randomUUID(), { from_version_id: fv1 })).status).toBe(404);
    expect((await carry(t.designerB, fv2, { from_version_id: crypto.randomUUID() })).status).toBe(404);
    expect((await carry(t.designerB, fv2, { from_version_id: t.version })).status).toBe(409);
    expect((await carry(t.designerB, fv2, { from_version_id: fv1, layer_ids: [t.layerDesign] })).status).toBe(404); // a layer of another drawing
    const empty = crypto.randomUUID();
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, occurred_at, created_by) values (${empty}, ${t.org}, ${free}, 3, ${T0}, ${t.designer})`;
    expect((await carry(t.designerB, empty, { from_version_id: fv1 })).status).toBe(409);
    const wbv = crypto.randomUUID();
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, occurred_at, created_by) values (${wbv}, ${t.org}, ${t.whiteboard}, 1, ${T0}, ${t.designer})`;
    expect((await carry(t.designerB, wbv, { from_version_id: fv1 })).status).toBe(409);
    expect(await ownerCount(owner, "drawings.annotations", { page_id: fq1 })).toBe(0);
  });

  it("unattached drawing: everything copies freely (no checkout, no proposals); copied rows carry copied_from_id / revision 1 / created_by = actor / same layer; page 3 rows are skipped (no_target_page); files referenced not duplicated", async () => {
    const r = await carry(t.designerB, fv2, { from_version_id: fv1 });
    expect(r.status).toBe(200);
    const b = r.body as CarryBody;
    expect(b.copied).toEqual({ annotations: 2, polygons: 1, placements: 1 });
    expect(b.skipped).toEqual({ total: 1, already_copied: 0, no_target_page: 1, layer_missing: 0 });
    expect(b.proposals).toBe(0);
    expect(b.pages).toEqual({ [fp1]: fq1, [fp2]: fq2 });
    const nS = (await ownerRow(owner, "drawings.annotations", b.ids[annS]))!;
    expect(nS).toMatchObject({ page_id: fq1, layer_id: fLayerS, kind: "rect", class: "structure", label: "closet", z: 3, room_hint: "Primary", copied_from_id: annS, revision: 1, created_by: t.designerB, walk_id: null });
    expect(nS.geometry).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(nS.style).toEqual({ stroke: "#000" });
    expect(nS.custom).toEqual({ k: 1 });
    const nC = (await ownerRow(owner, "drawings.annotations", b.ids[annC]))!;
    expect(nC).toMatchObject({ page_id: fq2, layer_id: fLayerC, class: "capture", checked: true, copied_from_id: annC, created_by: t.designerB });
    expect(b.ids[annC3]).toBeUndefined();
    const nP = (await ownerRow(owner, "places.room_polygons", b.ids[poly1]))!;
    expect(nP).toMatchObject({ drawing_id: free, drawing_version_id: fv2, page_id: fq1, room_hint: "Primary", copied_from_id: poly1, revision: 1, created_by: t.designerB, project_id: null });
    expect(nP.polygon).toEqual({ points: [[0, 0], [1, 0], [1, 1]] });
    const nL = (await ownerRow(owner, "places.location_placements", b.ids[pin1]))!;
    expect(nL).toMatchObject({ drawing_version_id: fv2, page_id: fq2, location_hint: "Primary TV", symbol_key: "tv", label_text: "TV", copied_from_id: pin1, revision: 1 });
    expect(Number(nL.x)).toBe(12.5);
    expect(await ownerCount(owner, "places.structure_changes", { drawing_id: free })).toBe(0);
    const ev = await ownerEvents(owner, { ref_id: fv2, event_type: "drawing_version.carried_forward" });
    expect(ev.length).toBe(1);
    expect((ev[0].payload as { copied: unknown }).copied).toEqual({ annotations: 2, polygons: 1, placements: 1 });
    // the compare sees the carried rows as the SAME rows (lineage) — no "added" for them
    const cmp = (await call("GET", t.techA, `/drawing-versions/${fv1}/compare/${fv2}`)).body as { changes: { entity: string; change: string }[] };
    expect(cmp.changes.filter((c) => c.change === "added")).toEqual([]);
    expect(cmp.changes.filter((c) => c.entity === "annotation" && c.change === "removed").length).toBe(1); // page-3 note has no descendant
  });

  it("re-running is a no-op (already_copied), including after a tombstoned descendant? no — a tombstoned copy is not live, so the source copies again", async () => {
    const again = (await carry(t.designerB, fv2, { from_version_id: fv1 })).body as CarryBody;
    expect(again.copied).toEqual({ annotations: 0, polygons: 0, placements: 0 });
    expect(again.skipped).toMatchObject({ already_copied: 4, no_target_page: 1, total: 5 });
    expect(await ownerCount(owner, "drawings.annotations", { page_id: fq1 })).toBe(1);
    // tombstone the carried structure annotation → the source is eligible again (live-descendant rule)
    const copyId = (await owner<{ id: string }[]>`select id from drawings.annotations where copied_from_id = ${annS}`)[0].id;
    await owner`update drawings.annotations set deleted_at = now(), deleted_by = ${t.designer} where id = ${copyId}`;
    const third = (await carry(t.designerB, fv2, { from_version_id: fv1, include: ["annotations"] })).body as CarryBody;
    expect(third.copied).toEqual({ annotations: 1, polygons: 0, placements: 0 });
    expect(third.skipped).toMatchObject({ already_copied: 1, no_target_page: 1 });
  });

  it("include + layer_ids filter; a tombstoned layer's rows are skipped (layer_missing)", async () => {
    // fresh target v4 of the free drawing with one page
    const v4 = crypto.randomUUID(), v4p1 = crypto.randomUUID();
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, page_count, occurred_at, created_by) values (${v4}, ${t.org}, ${free}, 4, 1, ${T0}, ${t.designer})`;
    await owner`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, source_page_no, occurred_at, created_by) values (${v4p1}, ${t.org}, ${free}, ${v4}, 1, 1, ${T0}, ${t.designer})`;
    const onlyC = (await carry(t.office, v4, { from_version_id: fv1, include: ["annotations"], layer_ids: [fLayerC] })).body as CarryBody;
    expect(onlyC.copied).toEqual({ annotations: 0, polygons: 0, placements: 0 }); // the capture rows sit on pages 2 / 3 — no partner on v4
    expect(onlyC.skipped).toMatchObject({ no_target_page: 2 });
    const onlyS = (await carry(t.office, v4, { from_version_id: fv1, include: ["annotations"], layer_ids: [fLayerS] })).body as CarryBody;
    expect(onlyS.copied).toEqual({ annotations: 1, polygons: 0, placements: 0 });
    expect(await ownerCount(owner, "places.room_polygons", { page_id: v4p1 })).toBe(0); // polygons not included
    await owner`update drawings.layers set deleted_at = now(), deleted_by = ${t.designer} where id = ${fLayerS}`;
    const v5 = crypto.randomUUID(), v5p1 = crypto.randomUUID();
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, page_count, occurred_at, created_by) values (${v5}, ${t.org}, ${free}, 5, 1, ${T0}, ${t.designer})`;
    await owner`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, source_page_no, occurred_at, created_by) values (${v5p1}, ${t.org}, ${free}, ${v5}, 1, 1, ${T0}, ${t.designer})`;
    const gone = (await carry(t.office, v5, { from_version_id: fv1, include: ["annotations"] })).body as CarryBody;
    expect(gone.skipped).toMatchObject({ layer_missing: 1, no_target_page: 2 });
    expect(gone.copied.annotations).toBe(0);
    await owner`update drawings.layers set deleted_at = null, deleted_by = null where id = ${fLayerS}`;
  });

  it("attached drawing: structure rows need the LIVE checkout — none → 409 (nothing copied); another holder → 403; capture-only (layer_ids) needs none", async () => {
    await setCheckout(owner, t, null);
    const none = await carry(t.designerB, av2, { from_version_id: t.version });
    expect(none.status).toBe(409);
    expect((none.body as { structure_rows: number }).structure_rows).toBe(3);
    expect(await ownerCount(owner, "drawings.annotations", { page_id: ap1 })).toBe(0);
    await setCheckout(owner, t, t.designer);
    expect((await carry(t.designerB, av2, { from_version_id: t.version })).status).toBe(403);
    // the capture row alone copies without the checkout (designerB is not the holder)
    const cap = (await carry(t.designerB, av2, { from_version_id: t.version, include: ["annotations"], layer_ids: [t.layerFieldNotes] })).body as CarryBody;
    expect(cap.copied).toEqual({ annotations: 1, polygons: 0, placements: 0 });
    expect(cap.proposals).toBe(0);
    expect((await ownerRow(owner, "drawings.annotations", cap.ids[aAnnC]))!).toMatchObject({ class: "capture", room_id: t.rooms.kitchen, copied_from_id: aAnnC });
  });

  it("attached drawing, holder carries: structure annotation → structure_changes('annotation'), polygon / placement → structure_changes('created'), all at the working revision with drawing_id, ref = the NEW rows; the review lists them", async () => {
    const r = await carry(t.designer, av2, { from_version_id: t.version });
    expect(r.status).toBe(200);
    const b = r.body as CarryBody;
    expect(b.copied).toEqual({ annotations: 1, polygons: 1, placements: 1 }); // the capture one was already carried
    expect(b.skipped).toMatchObject({ already_copied: 1 });
    expect(b.proposals).toBe(3);
    const changes = await owner<{ ref_table: string; ref_id: string; change_kind: string; revision: number; room_id: string | null; drawing_id: string; review_outcome: string | null; diff: Record<string, unknown> }[]>`
      select ref_table, ref_id, change_kind, revision, room_id, drawing_id, review_outcome, diff from places.structure_changes where id in ${owner(b.proposal_ids)} order by ref_table`;
    expect(changes.map((c) => [c.ref_table, c.change_kind])).toEqual([["drawings.annotations", "annotation"], ["places.location_placements", "created"], ["places.room_polygons", "created"]]);
    for (const c of changes) {
      expect(c).toMatchObject({ revision: 1, room_id: t.rooms.kitchen, drawing_id: t.drawing, review_outcome: null });
      expect(c.diff).toMatchObject({ op: "proposed", source: "carry_forward", from_version_id: t.version, to_version_id: av2 });
    }
    expect(changes.find((c) => c.ref_table === "drawings.annotations")!.ref_id).toBe(b.ids[aAnnS]);
    expect(changes.find((c) => c.ref_table === "places.room_polygons")!.ref_id).toBe(b.ids[aPoly]);
    const newPoly = (await ownerRow(owner, "places.room_polygons", b.ids[aPoly]))!;
    expect(newPoly).toMatchObject({ project_id: t.project, account_id: t.account, room_id: t.rooms.kitchen, drawing_version_id: av2, page_id: ap1, copied_from_id: aPoly, revision: 1, created_by: t.designer });
    const newPin = (await ownerRow(owner, "places.location_placements", b.ids[aPin]))!;
    expect(newPin).toMatchObject({ location_id: t.locationTv, room_id: t.rooms.kitchen, drawing_version_id: av2, copied_from_id: aPin });
    const review = (await call("GET", t.designer, `/projects/${t.project}/review`)).body as { pending_count: number; groups: { room_id: string | null; changes: { id: string }[] }[] };
    expect(review.pending_count).toBe(3);
    expect(review.groups[0].room_id).toBe(t.rooms.kitchen);
    // the originals are untouched
    expect((await ownerRow(owner, "drawings.annotations", aAnnS))!).toMatchObject({ revision: 1, deleted_at: null, copied_from_id: null });
    expect(await ownerCount(owner, "places.room_polygons", { page_id: t.page1 })).toBe(1);
    await setCheckout(owner, t, null);
  });
});
