//==============================================================================
// creds.ts — where the Zoho / Google OAuth credentials come from (F3: Postgres).
//
// Preference order (unchanged):
//   1. integration_credentials (written by the one-time /setup page) — normal path.
//   2. Env secrets (ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN, GOOGLE_OAUTH_*) — fallback.
//
// Was KV (`zoho_creds`, `google_creds`, `google_pending`, `zoho_scopes`). Now:
//   integration_credentials(system = 'zoho' | 'google' | 'google_pending')
//     ciphertext = AES-256-GCM(JSON) under the CREDS_KEY secret (base64, 32 bytes),
//     key_id = 'creds-key:v1'. The DB never sees plaintext (0001 comment).
//   tenant_settings 'zoho.setup_scopes' — the last OAuth scope string (not secret).
// Without CREDS_KEY the store is read-as-absent and saves refuse (SetupError-ish
// Error) — the env-secret fallback keeps working, so a missing key never takes
// Zoho/Google down; it only disables /setup persistence.
//==============================================================================

import type { Env } from "./types";
import { withTenant, withTenantRead, type Tx } from "./db";
import { getSetting, setSetting } from "./settings";
import { appendEvent } from "./events";
import { API_ACTOR, tenantOf } from "./repo/_shared";

export const CREDS_KEY_ID = "creds-key:v1";
const PENDING_TTL_MS = 15 * 60 * 1000;

export interface ZohoCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GoogleOAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

//------------------------------------------------------------------------------
// Crypto — AES-256-GCM with a 12-byte IV prefix; key from env.CREDS_KEY (base64).
//------------------------------------------------------------------------------

async function importKey(env: Pick<Env, "CREDS_KEY">): Promise<CryptoKey | null> {
  const b64 = (env.CREDS_KEY ?? "").trim();
  if (!b64) return null;
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("CREDS_KEY is not valid base64");
  }
  if (raw.byteLength !== 32) throw new Error("CREDS_KEY must decode to exactly 32 bytes (AES-256)");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(env: Pick<Env, "CREDS_KEY">, value: unknown): Promise<Uint8Array> {
  const key = await importKey(env);
  if (!key) throw new Error("CREDS_KEY is not configured (wrangler secret put CREDS_KEY) — cannot store credentials");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return out;
}

export async function decryptJson<T>(env: Pick<Env, "CREDS_KEY">, blob: Uint8Array): Promise<T | null> {
  const key = await importKey(env);
  if (!key || blob.byteLength < 13) return null;
  try {
    const iv = blob.subarray(0, 12);
    const ct = blob.subarray(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null; // wrong key / corrupt → treated as absent
  }
}

//------------------------------------------------------------------------------
// integration_credentials access (tx-level; shared with scripts/import-kv.ts)
//------------------------------------------------------------------------------

export async function readCredentialTx<T>(tx: Tx, env: Pick<Env, "CREDS_KEY">, system: string): Promise<{ value: T; updatedAt: Date } | null> {
  const rows = await tx<{ ciphertext: Uint8Array; updated_at: Date }[]>`
    select ciphertext, updated_at from public.integration_credentials
    where tenant_id = public.app_tenant_id() and system = ${system} limit 1`;
  if (!rows.length) return null;
  const value = await decryptJson<T>(env, new Uint8Array(rows[0].ciphertext));
  return value ? { value, updatedAt: rows[0].updated_at } : null;
}

export async function writeCredentialTx(tx: Tx, env: Pick<Env, "CREDS_KEY">, system: string, value: unknown, opts: { actor?: string; idempotencyKey?: string | null } = {}): Promise<void> {
  const ciphertext = await encryptJson(env, value);
  await tx`
    insert into public.integration_credentials (tenant_id, system, ciphertext, key_id)
    values (public.app_tenant_id(), ${system}, ${ciphertext}, ${CREDS_KEY_ID})
    on conflict (tenant_id, system) do update set ciphertext = excluded.ciphertext, key_id = excluded.key_id, updated_at = now()`;
  await appendEvent(tx, {
    entity: "integration_credentials",
    entityId: null,
    eventType: "credentials.saved",
    payload: { system, keyId: CREDS_KEY_ID }, // never the secret itself
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
}

async function hasCredentialTx(tx: Tx, system: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    select 1 as one from public.integration_credentials
    where tenant_id = public.app_tenant_id() and system = ${system} limit 1`;
  return rows.length > 0;
}

/** Never throws — a DB hiccup must not take Zoho/Google calls down; callers fall back to env. */
async function readCredential<T>(env: Env, system: string): Promise<T | null> {
  if (!(env.CREDS_KEY ?? "").trim()) return null;
  try {
    const r = await withTenantRead(env, tenantOf(env), (tx) => readCredentialTx<T>(tx, env, system));
    return r?.value ?? null;
  } catch (e) {
    console.warn(`creds: read ${system} failed (falling back to env):`, e);
    return null;
  }
}

//------------------------------------------------------------------------------
// Zoho
//------------------------------------------------------------------------------

/** Resolve Zoho creds from the DB first, then env. Returns null if neither is complete. */
export async function getZohoCreds(env: Env): Promise<ZohoCreds | null> {
  const c = await readCredential<ZohoCreds>(env, "zoho");
  if (c && c.clientId && c.clientSecret && c.refreshToken) return c;
  if (env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN) {
    return {
      clientId: env.ZOHO_CLIENT_ID,
      clientSecret: env.ZOHO_CLIENT_SECRET,
      refreshToken: env.ZOHO_REFRESH_TOKEN,
    };
  }
  return null;
}

/** Persist creds from the /setup exchange. */
export async function saveZohoCreds(env: Env, creds: ZohoCreds): Promise<void> {
  await withTenant(env, tenantOf(env), (tx) => writeCredentialTx(tx, env, "zoho", creds));
}

/** True once creds have been stored by /setup (used to lock /setup after first use). */
export async function isZohoConfiguredInStore(env: Env): Promise<boolean> {
  try {
    return await withTenantRead(env, tenantOf(env), (tx) => hasCredentialTx(tx, "zoho"));
  } catch {
    return false;
  }
}

const SCOPES_SETTING = "zoho.setup_scopes";

/** The OAuth scope string last entered on /setup, if any (null → compiled-in default). */
export async function getZohoScopes(env: Env): Promise<string | null> {
  try {
    const v = await withTenantRead(env, tenantOf(env), (tx) => getSetting(tx, SCOPES_SETTING));
    return typeof v === "string" && v.trim() ? v : null;
  } catch {
    return null;
  }
}

/** Persist the scope string from /setup so it becomes the shown default next time. */
export async function saveZohoScopes(env: Env, scopes: string): Promise<void> {
  await withTenant(env, tenantOf(env), (tx) => setSetting(tx, SCOPES_SETTING, scopes));
}

//------------------------------------------------------------------------------
// Google Calendar (oauth_user) — same pattern.
//------------------------------------------------------------------------------

/** Resolve Google oauth_user creds: DB first, then env. Null if incomplete. */
export async function getGoogleCreds(env: Env): Promise<GoogleOAuthCreds | null> {
  const c = await readCredential<GoogleOAuthCreds>(env, "google");
  if (c && c.clientId && c.clientSecret && c.refreshToken) return c;
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    };
  }
  return null;
}

export async function saveGoogleCreds(env: Env, creds: GoogleOAuthCreds): Promise<void> {
  await withTenant(env, tenantOf(env), (tx) => writeCredentialTx(tx, env, "google", creds));
}

export async function isGoogleConfiguredInStore(env: Env): Promise<boolean> {
  try {
    return await withTenantRead(env, tenantOf(env), (tx) => hasCredentialTx(tx, "google"));
  } catch {
    return false;
  }
}

/** Hold clientId/secret between the consent redirect and the callback (15-minute window). */
export async function saveGooglePending(env: Env, clientId: string, clientSecret: string): Promise<void> {
  await withTenant(env, tenantOf(env), (tx) => writeCredentialTx(tx, env, "google_pending", { clientId, clientSecret }));
}

export async function getGooglePending(env: Env): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const r = await withTenantRead(env, tenantOf(env), (tx) =>
      readCredentialTx<{ clientId: string; clientSecret: string }>(tx, env, "google_pending")
    );
    if (!r) return null;
    if (Date.now() - new Date(r.updatedAt).getTime() > PENDING_TTL_MS) return null; // expired like the KV TTL
    return r.value;
  } catch {
    return null;
  }
}
