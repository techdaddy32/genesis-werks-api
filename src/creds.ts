//==============================================================================
// creds.ts — where the Zoho credentials come from.
//
// Preference order:
//   1. KV key `zoho_creds` (written by the one-time /setup page) — the normal path.
//   2. Env secrets (ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN) — fallback if you'd rather
//      set them with `wrangler secret put`.
// This lets the browser-based /setup flow fully replace the CLI secret dance:
// once /setup stores creds in KV, those win over any (possibly stale) env secrets.
//==============================================================================

import type { Env } from "./types";

const KV_KEY = "zoho_creds";

export interface ZohoCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Resolve Zoho creds from KV first, then env. Returns null if neither is complete. */
export async function getZohoCreds(env: Env): Promise<ZohoCreds | null> {
  const raw = await env.WO_KV.get(KV_KEY);
  if (raw) {
    try {
      const c = JSON.parse(raw) as ZohoCreds;
      if (c.clientId && c.clientSecret && c.refreshToken) return c;
    } catch {
      /* fall through to env */
    }
  }
  if (env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN) {
    return {
      clientId: env.ZOHO_CLIENT_ID,
      clientSecret: env.ZOHO_CLIENT_SECRET,
      refreshToken: env.ZOHO_REFRESH_TOKEN,
    };
  }
  return null;
}

/** Persist creds from the /setup exchange into KV. */
export async function saveZohoCreds(env: Env, creds: ZohoCreds): Promise<void> {
  await env.WO_KV.put(KV_KEY, JSON.stringify(creds));
}

/** True once creds have been written to KV (used to lock /setup after first use). */
export async function isZohoConfiguredInKv(env: Env): Promise<boolean> {
  return (await env.WO_KV.get(KV_KEY)) !== null;
}

const SCOPES_KEY = "zoho_scopes";

/**
 * The OAuth scope string last entered on /setup, if any. Lets the scope be changed from the
 * setup page (and remembered) without a code edit + redeploy. Null if never set → caller uses
 * its compiled-in default.
 */
export async function getZohoScopes(env: Env): Promise<string | null> {
  return await env.WO_KV.get(SCOPES_KEY);
}

/** Persist the scope string from /setup so it becomes the shown default next time. */
export async function saveZohoScopes(env: Env, scopes: string): Promise<void> {
  await env.WO_KV.put(SCOPES_KEY, scopes);
}

//==============================================================================
// Google Calendar (oauth_user) credentials — same KV-first pattern.
//==============================================================================
const G_KEY = "google_creds";
const G_PENDING = "google_pending"; // clientId/secret held between /setup/google start and callback

export interface GoogleOAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Resolve Google oauth_user creds: KV first, then env. Null if incomplete. */
export async function getGoogleCreds(env: Env): Promise<GoogleOAuthCreds | null> {
  const raw = await env.WO_KV.get(G_KEY);
  if (raw) {
    try {
      const c = JSON.parse(raw) as GoogleOAuthCreds;
      if (c.clientId && c.clientSecret && c.refreshToken) return c;
    } catch {
      /* fall through */
    }
  }
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
  await env.WO_KV.put(G_KEY, JSON.stringify(creds));
}

export async function isGoogleConfiguredInKv(env: Env): Promise<boolean> {
  return (await env.WO_KV.get(G_KEY)) !== null;
}

/** Hold clientId/secret between the consent redirect and the callback. */
export async function saveGooglePending(env: Env, clientId: string, clientSecret: string): Promise<void> {
  await env.WO_KV.put(G_PENDING, JSON.stringify({ clientId, clientSecret }), { expirationTtl: 900 });
}

export async function getGooglePending(env: Env): Promise<{ clientId: string; clientSecret: string } | null> {
  const raw = await env.WO_KV.get(G_PENDING);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { clientId: string; clientSecret: string };
  } catch {
    return null;
  }
}
