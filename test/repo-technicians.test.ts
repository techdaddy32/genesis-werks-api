//==============================================================================
// repo-technicians.test.ts — technicians + people registries on Postgres (F3).
// Skips when the test database is down (see F2-NOTES "How to run the tests").
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createScratchTenant, countEvents, dbAvailable, sharedSql, testEnv } from "./_pg";
import type { Sql } from "../src/db";
import type { Env } from "../src/types";
import * as techs from "../src/repo/technicians";
import * as people from "../src/repo/people";

const up = await dbAvailable();

describe.skipIf(!up)("repo/technicians + repo/people (Postgres)", () => {
  let sql: Sql;
  let env: Env;
  let tenant: string;

  beforeAll(async () => {
    sql = sharedSql();
    tenant = await createScratchTenant(testEnv(), sql, "techs");
    env = testEnv({ TENANT_ID: tenant });
  });
  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  it("starts empty", async () => {
    expect(await techs.listTechnicians(env)).toEqual([]);
    expect(await people.getPeople(env)).toEqual([]);
  });

  it("adds a technician with the exact Technician key order and lower-cased email", async () => {
    const t = await techs.addTechnician(env, { name: "Bob Builder", email: "Bob@Example.com " });
    expect(Object.keys(t)).toEqual(["id", "name", "email", "active", "createdAt", "updatedAt"]);
    expect(t.email).toBe("bob@example.com");
    expect(t.active).toBe(true);
    expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await countEvents(env, sql, tenant, "technician.created")).toBe(1);
  });

  it("rejects a duplicate email (same 400 message) and bad input", async () => {
    await expect(techs.addTechnician(env, { name: "Robert", email: "BOB@example.com" })).rejects.toThrow(
      "a technician with email bob@example.com already exists"
    );
    await expect(techs.addTechnician(env, { name: "", email: "x@y.z" })).rejects.toThrow("name is required");
    await expect(techs.addTechnician(env, { name: "X", email: "nope" })).rejects.toThrow("invalid email: 'nope'");
  });

  it("lists sorted by name, activeOnly filters, update toggles active and edits", async () => {
    const a = await techs.addTechnician(env, { name: "Alice", email: "alice@example.com" });
    const list = await techs.listTechnicians(env);
    expect(list.map((t) => t.name)).toEqual(["Alice", "Bob Builder"]);

    const upd = await techs.updateTechnician(env, a.id, { active: false, name: "Alice A." });
    expect(upd).toMatchObject({ id: a.id, name: "Alice A.", active: false });
    expect(upd!.updatedAt >= a.updatedAt).toBe(true);
    expect((await techs.listTechnicians(env, { activeOnly: true })).map((t) => t.name)).toEqual(["Bob Builder"]);
    expect(await techs.updateTechnician(env, crypto.randomUUID(), { name: "ghost" })).toBeNull();
  });

  it("resolveGuestEmails returns active techs' emails only, unknown ids skipped", async () => {
    const all = await techs.listTechnicians(env);
    const bob = all.find((t) => t.name === "Bob Builder")!;
    const alice = all.find((t) => t.name === "Alice A.")!;
    expect(await techs.resolveGuestEmails(env, [bob.id, alice.id, "nope"])).toEqual(["bob@example.com"]);
    expect(await techs.resolveGuestEmails(env, [])).toEqual([]);
  });

  it("people: Person key order, email '' when unset, zohoUser null, dup name refused", async () => {
    const p = await people.savePerson(env, { name: "Carol" });
    expect(Object.keys(p)).toEqual(["id", "name", "email", "active", "zohoUser", "createdAt", "updatedAt"]);
    expect(p.email).toBe("");
    expect(p.zohoUser).toBeNull();
    await expect(people.savePerson(env, { name: "carol " })).rejects.toThrow("a person named carol already exists");
    const upd = await people.updatePerson(env, p.id, { zohoUser: " Carol Z ", email: "Carol@Example.com" });
    expect(upd).toMatchObject({ zohoUser: "Carol Z", email: "carol@example.com" });
    const cleared = await people.updatePerson(env, p.id, { zohoUser: "" });
    expect(cleared!.zohoUser).toBeNull();
  });

  it("people = ALL users (technicians included) — the unified model; activeOnly filters", async () => {
    const all = await people.getPeople(env);
    expect(all.map((p) => p.name)).toEqual(["Alice A.", "Bob Builder", "Carol"]);
    const active = await people.getPeople(env, { activeOnly: true });
    expect(active.map((p) => p.name)).toEqual(["Bob Builder", "Carol"]);
  });

  it("adding a technician with an existing person's email PROMOTES that user instead of duplicating", async () => {
    const before = await people.getPeople(env);
    const carol = before.find((p) => p.name === "Carol")!;
    const t = await techs.addTechnician(env, { name: "Carol Tech", email: "carol@example.com" });
    expect(t.id).toBe(carol.id);
    expect((await people.getPeople(env)).length).toBe(before.length);
    expect(await countEvents(env, sql, tenant, "technician.promoted")).toBe(1);
  });

  it("is tenant-isolated: another tenant sees none of these rows", async () => {
    const other = await createScratchTenant(testEnv(), sql, "techs-other");
    expect(await techs.listTechnicians(testEnv({ TENANT_ID: other }))).toEqual([]);
    expect(await people.getPeople(testEnv({ TENANT_ID: other }))).toEqual([]);
  });
});
