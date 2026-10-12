// row: K2 · run: run-2026-10-07-drawing-layer-15 · 2026-10-12 — catalog routes (catalog/read.ts · catalog/write.ts) + the §3a sync-set columns
// Real DB (058 applied: base rows present). A fresh fictitious Organization sees the Horizon base and nothing of the sandbox org.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, setCheckout, syncEnv, syncRequest, callSync, syncSet, ownerEvents, ownerRow, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

type Item = Record<string, unknown> & { id: string; kind: string; key: string; status: string; organization_id: string | null; override_of: string | null; revision: number; updated_at: string };
interface CatalogOut { legend_sets: Item[]; items: Item[]; bundle_lines: Record<string, unknown>[]; tombstones: string[]; etag: string; generated_at: string; since: string | null }

const BASE_WAP = "019b0000-0000-7000-8000-000000000101";
const BASE_CAM = "019b0000-0000-7000-8000-000000000107";
const BASE_DATA = "019b0000-0000-7000-8000-000000000110";
const SANDBOX_ORG = "019a0000-0000-7000-8000-000000000001";

describe.skipIf(!available)("catalog (K2)", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) }));
  const load = async (actor: string, qs = "") => {
    const r = await call("GET", actor, `/catalog${qs}`);
    expect(r.status).toBe(200);
    return r.body as CatalogOut;
  };

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "catalog");
    await setCheckout(owner, t, t.designer);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("GET /catalog (technician): the Horizon base — 40 active symbols, TBD rows, legend sets — and nothing of another organization", async () => {
    const b = await load(t.techA);
    expect(b.items.filter((i) => i.kind === "symbol" && i.status === "active")).toHaveLength(40);
    expect(b.items.filter((i) => i.status === "tbd").length).toBeGreaterThanOrEqual(7);
    expect(b.items.every((i) => i.organization_id === null)).toBe(true);
    expect(b.items.some((i) => i.organization_id === SANDBOX_ORG)).toBe(false);
    expect(b.legend_sets.map((s) => s.key).sort()).toEqual(["lighting", "lv", "shades", "tv"]);
    expect(b.legend_sets.find((s) => s.key === "shades")?.status).toBe("tbd");
    expect(b.tombstones).toEqual([]);
    const wap = b.items.find((i) => i.key === "wap" && i.kind === "symbol")!;
    expect(wap).toMatchObject({ id: BASE_WAP, default_label: "WAP", legend_set_key: "lv" });
    // filters
    expect((await load(t.techA, "?kind=wire")).items.every((i) => i.kind === "wire")).toBe(true);
    const lighting = await load(t.techA, "?legend_set=lighting&kind=symbol");
    expect(lighting.items).toHaveLength(26);
    expect((await call("GET", t.techA, "/catalog?kind=widget")).status).toBe(400);
  });

  it("ETag: header + body agree; If-None-Match → 304 with no body; a write moves the tag", async () => {
    const r1 = await call("GET", t.techA, "/catalog");
    expect(r1.status).toBe(200);
    const etag = r1.headers?.ETag;
    expect(etag).toBe(`"${(r1.body as CatalogOut).etag}"`);
    const r2 = await call("GET", t.techA, "/catalog", undefined, { "If-None-Match": etag! });
    expect(r2.status).toBe(304);
    expect(r2.headers?.ETag).toBe(etag);
    const r3 = await call("GET", t.techA, "/catalog", undefined, { "If-None-Match": `W/${etag}` });
    expect(r3.status).toBe(304);
    // a different filter never shares the tag
    expect((await call("GET", t.techA, "/catalog?kind=wire")).headers?.ETag).not.toBe(etag);
    const w = await call("POST", t.office, "/catalog/items", { kind: "accessory", key: "etag_probe", name: "ETag probe", category: "Trim", attaches_to: "any", unit: "ea" });
    expect(w.status).toBe(201);
    const r4 = await call("GET", t.techA, "/catalog", undefined, { "If-None-Match": etag! });
    expect(r4.status).toBe(200);
    expect(r4.headers?.ETag).not.toBe(etag);
  });

  it("POST /catalog/items: org wire 201 · duplicate key 409 · technician 403 · label > 3 chars 400 · connector source 400 · minimum fields 400 unless tbd", async () => {
    const r = await call("POST", t.office, "/catalog/items", { kind: "wire", key: "cat6_plenum", name: "Cat6 plenum", wire_type: "cat6", gauge: "23 AWG", conductors: 8, jacket: "CMP", color: "white", default_label: "6P", unit: "ft" });
    expect(r.status).toBe(201);
    const item = (r.body as { item: Item }).item;
    expect(item).toMatchObject({ organization_id: t.org, kind: "wire", key: "cat6_plenum", source: "manual", revision: 1, status: "active" });
    expect((await call("POST", t.office, "/catalog/items", { kind: "wire", key: "cat6_plenum", name: "again", wire_type: "cat6", gauge: "23 AWG", unit: "ft" })).status).toBe(409);
    expect((await call("POST", t.techA, "/catalog/items", { kind: "wire", key: "tech_wire", name: "nope", wire_type: "cat6", gauge: "23 AWG", unit: "ft" })).status).toBe(403);
    const long = await call("POST", t.office, "/catalog/items", { kind: "symbol", key: "long_label", name: "Long", default_label: "ABCD", class: "misc", legend_set_key: "lv" });
    expect(long.status).toBe(400);
    expect(String((long.body as { error: string }).error)).toMatch(/1 to 3 characters/);
    const conn = await call("POST", t.office, "/catalog/items", { kind: "wire", key: "sd_wire", name: "pulled", source: "smackdab", wire_type: "cat6", gauge: "23 AWG", unit: "ft" });
    expect(conn.status).toBe(400);
    expect(String((conn.body as { error: string }).error)).toMatch(/gateway/);
    expect((await call("POST", t.office, "/catalog/items", { kind: "device", key: "no_min", name: "missing fields" })).status).toBe(400);
    const tbd = await call("POST", t.office, "/catalog/items", { kind: "device", key: "later", name: "Define later", status: "tbd" });
    expect(tbd.status).toBe(201);
    // a device over a BASE symbol by key, with a base wire by key
    const dev = await call("POST", t.office, "/catalog/items", { kind: "device", key: "u6_pro", name: "U6 Pro", manufacturer: "Ubiquiti", model: "U6-PRO", category: "Network", symbol_key: "wap", default_wire_key: "cat6", default_label: "AP" });
    expect(dev.status).toBe(201);
    expect((dev.body as { item: Item }).item).toMatchObject({ symbol_item_id: BASE_WAP, default_wire_item_id: "019b0000-0000-7000-8000-000000000301" });
    expect((await call("POST", t.office, "/catalog/items", { kind: "device", key: "bad_ref", name: "x", category: "Network", symbol_key: "no_such_symbol" })).status).toBe(422);
    const ev = await ownerEvents(owner, { ref_id: item.id, event_type: "catalog.item.changed" });
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ op: "created", kind: "wire", key: "cat6_plenum" });
    // the org row is in the merged view, the base rows untouched
    const b = await load(t.techA, "?kind=wire");
    expect(b.items.filter((i) => i.key === "cat6_plenum")).toHaveLength(1);
    expect(b.items.filter((i) => i.organization_id === null)).toHaveLength(9);
  });

  it("PATCH a BASE row → mints the org's override (201, override_of) and REPLACES the base in the merged view; a second PATCH updates the override (200); the base row is untouched", async () => {
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const r1 = await call("PATCH", t.office, `/catalog/items/${BASE_WAP}`, { default_label: "AP", name: "Access Point (ours)" });
    expect(r1.status).toBe(201);
    const o1 = (r1.body as { item: Item; overrode: boolean; base_id: string });
    expect(o1.overrode).toBe(true);
    expect(o1.base_id).toBe(BASE_WAP);
    expect(o1.item).toMatchObject({ organization_id: t.org, kind: "symbol", key: "wap", override_of: BASE_WAP, default_label: "AP", name: "Access Point (ours)", class: "net", legend_set_id: "019b0000-0000-7000-8000-000000000001", revision: 1, source: "manual" });
    const overrideId = o1.item.id;
    expect(overrideId).not.toBe(BASE_WAP);

    const r2 = await call("PATCH", t.office, `/catalog/items/${BASE_WAP}`, { color_hint: "#0af" });
    expect(r2.status).toBe(200);
    expect((r2.body as { item: Item }).item).toMatchObject({ id: overrideId, revision: 2, color_hint: "#0af", default_label: "AP" });
    const r3 = await call("PATCH", t.office, `/catalog/items/${overrideId}`, { name: "Access Point" });
    expect(r3.status).toBe(200);
    expect((r3.body as { item: Item }).item).toMatchObject({ id: overrideId, revision: 3, name: "Access Point" });

    const base = await ownerRow(owner, "catalog.items", BASE_WAP);
    expect(base).toMatchObject({ default_label: "WAP", name: "Wireless Access Point", revision: 1, organization_id: null });

    const b = await load(t.techA, "?kind=symbol");
    const waps = b.items.filter((i) => i.key === "wap");
    expect(waps).toHaveLength(1);
    expect(waps[0]).toMatchObject({ id: overrideId, override_of: BASE_WAP, default_label: "AP" });
    expect(b.items.filter((i) => i.status === "active")).toHaveLength(40);
    // GET one: the base id resolves to the override
    const one = await call("GET", t.techA, `/catalog/items/${BASE_WAP}`);
    expect(one.status).toBe(200);
    expect((one.body as { item: Item; resolved_from: string | null })).toMatchObject({ resolved_from: BASE_WAP });
    expect((one.body as { item: Item }).item.id).toBe(overrideId);

    // delta: the override arrives, the base id it shadows is a tombstone
    const d = await load(t.techA, `?since=${encodeURIComponent(since)}`);
    expect(d.items.map((i) => i.id)).toContain(overrideId);
    expect(d.items.map((i) => i.id)).not.toContain(BASE_WAP);
    expect(d.tombstones).toContain(BASE_WAP);
    // immutables
    expect((await call("PATCH", t.office, `/catalog/items/${overrideId}`, { key: "wap2" })).status).toBe(400);
    expect((await call("PATCH", t.office, `/catalog/items/${overrideId}`, {})).status).toBe(400);
    expect((await call("PATCH", t.techA, `/catalog/items/${overrideId}`, { name: "x" })).status).toBe(403);
    expect((await call("PATCH", t.office, `/catalog/items/${overrideId}`, { default_label: "ABCD" })).status).toBe(400);
  });

  it("hide: POST /catalog/items/:id/hide on a base symbol → hidden override; it leaves the palette unless include_hidden=1; DELETE → 405", async () => {
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const r = await call("POST", t.office, `/catalog/items/${BASE_CAM}/hide`);
    expect(r.status).toBe(201);
    const hid = (r.body as { item: Item }).item;
    expect(hid).toMatchObject({ status: "hidden", override_of: BASE_CAM, key: "cam" });
    const b = await load(t.techA, "?kind=symbol");
    expect(b.items.some((i) => i.key === "cam")).toBe(false);
    expect(b.items.filter((i) => i.status === "active")).toHaveLength(39);
    const all = await load(t.techA, "?kind=symbol&include_hidden=1");
    expect(all.items.find((i) => i.key === "cam")).toMatchObject({ id: hid.id, status: "hidden" });
    const d = await load(t.techA, `?since=${encodeURIComponent(since)}`);
    expect(d.tombstones).toEqual(expect.arrayContaining([hid.id, BASE_CAM]));
    expect(d.items.some((i) => i.key === "cam")).toBe(false);
    // un-hide = PATCH the override's status
    expect((await call("PATCH", t.office, `/catalog/items/${BASE_CAM}`, { status: "active" })).status).toBe(200);
    expect((await load(t.techA, "?kind=symbol")).items.filter((i) => i.status === "active")).toHaveLength(40);
    expect((await call("DELETE", t.office, `/catalog/items/${hid.id}`)).status).toBe(405);
    expect((await call("DELETE", t.office, `/catalog/items/${BASE_CAM}`)).status).toBe(405);
    expect((await call("DELETE", t.designer, "/catalog")).status).toBe(405);
    expect(await ownerRow(owner, "catalog.items", BASE_CAM)).toMatchObject({ status: "active", deleted_at: null });
  });

  it("bundles: POST an org bundle over a base symbol, PUT its lines (replace semantics), GET lines; base bundle lines → 409; technician → 403", async () => {
    const r = await call("POST", t.office, "/catalog/items", { kind: "bundle", key: "data_pw", name: "Data PW", part_number: "PW-DATA-1", symbol_key: "data", category: "Structured Wiring", default_label: "D" });
    expect(r.status).toBe(201);
    const bundle = (r.body as { item: Item }).item;
    expect(bundle.symbol_item_id).toBe(BASE_DATA);
    const p1 = await call("PUT", t.office, `/catalog/bundles/${bundle.id}/lines`, [{ line_item_key: "cat6", quantity: 150, unit: "ft" }, { line_item_key: "mudring_1g", quantity: 1 }, { line_item_key: "plate_keystone" }]);
    expect(p1.status).toBe(200);
    const l1 = (p1.body as { lines: Record<string, unknown>[]; removed: number });
    expect(l1.lines.map((l) => [l.line_item_key, Number(l.quantity), l.unit_resolved])).toEqual([["cat6", 150, "ft"], ["mudring_1g", 1, "ea"], ["plate_keystone", 1, "ea"]]);
    const p2 = await call("PUT", t.office, `/catalog/bundles/${bundle.id}/lines`, { lines: [{ line_item_key: "cat6", quantity: 200, unit: "ft" }] });
    expect(p2.status).toBe(200);
    expect((p2.body as { removed: number }).removed).toBe(2);
    const g = await call("GET", t.techA, `/catalog/bundles/${bundle.id}/lines`);
    expect(g.status).toBe(200);
    expect((g.body as { lines: Record<string, unknown>[] }).lines.map((l) => [l.line_item_key, Number(l.quantity)])).toEqual([["cat6", 200]]);
    const full = await load(t.techA, "?kind=bundle");
    expect(full.bundle_lines.filter((l) => l.bundle_item_id === bundle.id)).toHaveLength(1);
    expect(full.items.find((i) => i.id === bundle.id)?.revision).toBe(3);
    const ev = await ownerEvents(owner, { ref_id: bundle.id, event_type: "catalog.bundle.changed" });
    expect(ev).toHaveLength(2);
    // bad lines
    expect((await call("PUT", t.office, `/catalog/bundles/${bundle.id}/lines`, [{ line_item_key: "cat6", quantity: 0 }])).status).toBe(400);
    expect((await call("PUT", t.office, `/catalog/bundles/${bundle.id}/lines`, [{ line_item_key: "wap" }])).status).toBe(422);
    expect((await call("PUT", t.office, `/catalog/bundles/${bundle.id}/lines`, [{ line_item_id: BASE_WAP }])).status).toBe(400);
    expect((await call("PUT", t.techA, `/catalog/bundles/${bundle.id}/lines`, [])).status).toBe(403);
    // the base TBD bundle has no org override → 409
    expect((await call("PUT", t.office, "/catalog/bundles/019b0000-0000-7000-8000-000000000904/lines", [])).status).toBe(409);
    expect((await call("GET", t.techA, `/catalog/bundles/${BASE_WAP}/lines`)).status).toBe(409);
  });

  it("connector-sourced item: a manual PATCH flips source → manual and keeps the pulled values beside it (contract §4)", async () => {
    const id = crypto.randomUUID();
    await owner`insert into catalog.items (id, organization_id, kind, key, name, wire_type, gauge, unit, source, external_id)
                values (${id}, ${t.org}, 'wire', 'sd_cat6', 'Cat6 (Smackdab)', 'cat6', '23 AWG', 'ft', 'smackdab', 'SD-100')`;
    const r = await call("PATCH", t.office, `/catalog/items/${id}`, { name: "Cat6 (ours)", color: "blue" });
    expect(r.status).toBe(200);
    const item = (r.body as { item: Item }).item;
    expect(item).toMatchObject({ source: "manual", external_id: "SD-100", name: "Cat6 (ours)", color: "blue", revision: 2 });
    const pv = item.pulled_values as { source: string; external_id: string; values: Record<string, unknown> };
    expect(pv.source).toBe("smackdab");
    expect(pv.external_id).toBe("SD-100");
    expect(pv.values).toMatchObject({ name: "Cat6 (Smackdab)", color: null, gauge: "23 AWG" });
    // a second manual edit leaves pulled_values as the connector left them
    const r2 = await call("PATCH", t.office, `/catalog/items/${id}`, { name: "Cat6 (ours again)" });
    expect((r2.body as { item: Item }).item.pulled_values).toEqual(pv);
    const ev = await ownerEvents(owner, { ref_id: id });
    expect(ev[0].payload).toMatchObject({ source_flipped: true, previous_source: "smackdab" });
    expect((await call("PATCH", t.office, `/catalog/items/${id}`, { source: "smackdab" })).status).toBe(400);
  });

  it("glyph: POST /catalog/items/:id/glyph presigns through the files flow (kind glyph, image/svg+xml, <key>.svg); PUT bytes; PATCH glyph_file_id", async () => {
    const sym = await call("POST", t.office, "/catalog/items", { kind: "symbol", key: "our_mark", name: "Our mark", default_label: "OM", class: "misc", legend_set_key: "lv" });
    expect(sym.status).toBe(201);
    const symId = (sym.body as { item: Item }).item.id;
    expect((await call("POST", t.techA, `/catalog/items/${symId}/glyph`)).status).toBe(403);
    const g = await call("POST", t.office, `/catalog/items/${symId}/glyph`);
    expect(g.status).toBe(201);
    const gb = g.body as { file_id: string; put_url: string; item_id: string; then: string };
    expect(gb.item_id).toBe(symId);
    expect(gb.put_url).toBe(`http://worker.test/sync/files/${gb.file_id}`);
    expect(await ownerRow(owner, "shared.files", gb.file_id)).toMatchObject({ kind: "glyph", content_type: "image/svg+xml", filename: "our_mark.svg", upload_status: "pending", organization_id: t.org });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    const put = await callSync(env, syncRequest("PUT", `/sync/files/${gb.file_id}`, { actor: t.office, org: t.org, rawBody: svg, headers: { "Content-Type": "image/svg+xml" } }));
    expect(put.status).toBe(200);
    const p = await call("PATCH", t.office, `/catalog/items/${symId}`, { glyph_file_id: gb.file_id });
    expect(p.status).toBe(200);
    expect((p.body as { item: Item }).item.glyph_file_id).toBe(gb.file_id);
    // a wire has no glyph
    expect((await call("POST", t.office, "/catalog/items/019b0000-0000-7000-8000-000000000301/glyph")).status).toBe(409);
  });

  it("sync set (K1 §3a): device_key / bundle_key / legend_set_key ride the push path on device_placements and location_placements (push-shape test)", async () => {
    const dp = syncSet(t, t.designer, { project_id: t.project, account_id: t.account, room_id: t.rooms.kitchen, location_id: t.locationTv, capture_kind: "plan", product_name: "TV drop", catalog_key: "tv", device_key: null, bundle_key: "fhi_tv_2c6_2c6a", placement_status: "planned" });
    const lp = syncSet(t, t.designer, { project_id: t.project, drawing_id: t.drawing, page_id: t.page1, location_id: t.locationTv, room_id: t.rooms.kitchen, x: 3, y: 4, symbol_key: "tv", label_text: "TV", device_key: "u6_pro", bundle_key: null, legend_set_key: "lv" });
    const r = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designer, org: t.org, body: { device_id: "test-device", rows: [{ table: "places.device_placements", row: dp }, { table: "places.location_placements", row: lp }] } }))).body as PushResult;
    expect(r.rejected).toEqual([]);
    expect(await ownerRow(owner, "places.device_placements", dp.id as string)).toMatchObject({ catalog_key: "tv", device_key: null, bundle_key: "fhi_tv_2c6_2c6a" });
    expect(await ownerRow(owner, "places.location_placements", lp.id as string)).toMatchObject({ symbol_key: "tv", device_key: "u6_pro", bundle_key: null, legend_set_key: "lv" });
  });
});
