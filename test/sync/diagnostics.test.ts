// row: A2-fix4 · run: run-2026-10-07-drawing-layer-09 · 2026-10-09 — POST/GET /diagnostics
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, type Sql, type TestOrg } from "./_db";

const available = await dbAvailable();

describe.skipIf(!available)("device diagnostics (A2-fix4)", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  beforeAll(async () => { owner = ownerSql(); t = await createTestOrg(owner, "diag"); });
  afterAll(async () => { await owner.end(); });

  it("a technician posts a diagnostic; office lists it; technician cannot list; 400 without message", async () => {
    const post = await call("POST", t.techA, "/diagnostics", { message: "read: FunctionCallException: boom", kind: "photo", device_id: "ios-test" });
    expect(post.status).toBe(201);
    expect((await call("POST", t.techA, "/diagnostics", {})).status).toBe(400);
    expect((await call("GET", t.techA, "/diagnostics")).status).toBe(403);
    const list = await call("GET", t.office, "/diagnostics?limit=5");
    expect(list.status).toBe(200);
    const d = (list.body as { diagnostics: { payload: { message: string; kind: string }; device_id: string }[] }).diagnostics;
    expect(d[0].payload.message).toContain("FunctionCallException");
    expect(d[0].payload.kind).toBe("photo");
    expect(d[0].device_id).toBe("ios-test");
  });
});
