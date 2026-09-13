//==============================================================================
// setup.ts — one-time browser setup for Zoho credentials.
//
// GET  /setup  -> an HTML form (Client ID, Client Secret, Grant Code).
// POST /setup  -> exchanges the grant code for a refresh token (Worker CAN reach
//                 Zoho), stores {clientId, clientSecret, refreshToken} encrypted in
//                 integration_credentials (F3; was KV), and
//                 shows a success page. No curl, no `wrangler secret put`.
//
// Lock: the first time (nothing stored) it's open. Once creds are stored, reconfiguring
// requires a matching ?/field `token` equal to the optional SETUP_TOKEN var — so a
// stranger who finds the URL can't overwrite live creds.
//==============================================================================

import type { Env } from "./types";
import {
  saveZohoCreds,
  isZohoConfiguredInStore,
  getZohoScopes,
  saveZohoScopes,
  saveGooglePending,
  getGooglePending,
  saveGoogleCreds,
  isGoogleConfiguredInStore,
} from "./creds";
import { _clearTokenCache } from "./zoho";
import { _clearGoogleTokenCache } from "./calendar";

const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar";
/** The redirect URI Craig must register on his Google OAuth client. */
export function googleRedirectUri(baseUrl: string): string {
  return `${baseUrl}/setup/google/callback`;
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

const ZOHO_CONSOLE = "https://api-console.zoho.com";
/** Compiled-in default scope. Editable on /setup and remembered in tenant_settings (getZohoScopes), so the
 *  scope can change without a code edit + redeploy. */
const DEFAULT_SCOPES = "ZohoProjects.portals.READ,ZohoProjects.projects.ALL,ZohoProjects.tasklists.ALL,ZohoProjects.tasks.ALL,ZohoProjects.forums.ALL,ZohoProjects.bugs.ALL,ZohoProjects.users.READ";

/** GET /setup — render both the Zoho and Google setup sections. */
export async function renderSetupForm(env: Env, baseUrl: string, notice = ""): Promise<string> {
  const zohoOk = await isZohoConfiguredInStore(env);
  const googleOk = await isGoogleConfiguredInStore(env);
  const scopes = (await getZohoScopes(env)) || DEFAULT_SCOPES;
  const lockNote = zohoOk
    ? `<div class="warn">Zoho is already configured. Resubmitting needs the setup token (SETUP_TOKEN).</div>`
    : "";
  const tokenField = zohoOk
    ? `<label>Setup token <span class="hint">(required to reconfigure)</span><input name="token" type="password" autocomplete="off"></label>`
    : "";
  const redirect = googleRedirectUri(baseUrl);

  return page(`
    <h1>Backend Setup</h1>
    <p class="lead">Connect the two services the Service Work Order backend uses. Everything is stored
    only in this Worker.</p>
    <div class="status">
      <span class="pill ${zohoOk ? "on" : "off"}">Zoho ${zohoOk ? "connected ✓" : "not connected"}</span>
      <span class="pill ${googleOk ? "on" : "off"}">Google ${googleOk ? "connected ✓" : "not connected"}</span>
    </div>
    ${notice}

    <h2>1 · Zoho Projects</h2>
    ${lockNote}
    <ol class="steps">
      <li>Edit the <b>Scopes</b> below if needed (add/remove services). Whatever's here is remembered —
        no redeploy to change it.</li>
      <li><a href="${ZOHO_CONSOLE}" target="_blank" rel="noopener">Zoho API Console</a> → your
        <b>Self Client</b> → <b>Generate Code</b>. Paste this exact scope:
        <code id="scopeEcho">${escapeHtml(scopes)}</code> · Duration 10 min · <b>Create</b>, copy the code.</li>
      <li>Copy your <b>Client ID</b> and <b>Client Secret</b>, paste all three below (code expires ~10 min).</li>
    </ol>
    <form method="POST" action="/setup" autocomplete="off">
      <label>Scopes <span class="hint">(edit to add/remove services; kept for next time)</span>
        <input name="scopes" value="${escapeHtml(scopes)}" required autocomplete="off"
          oninput="var e=document.getElementById('scopeEcho');if(e)e.textContent=this.value"></label>
      <label>Client ID<input name="clientId" required autocomplete="off"></label>
      <label>Client Secret<input name="clientSecret" type="password" required autocomplete="off"></label>
      <label>Grant Code<input name="code" required autocomplete="off"></label>
      ${tokenField}
      <button type="submit">Connect Zoho</button>
    </form>

    <h2 style="margin-top:26px">2 · Google Calendar</h2>
    <ol class="steps">
      <li><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud → Credentials</a>
        → your <b>OAuth client</b> (Web application).</li>
      <li>Under <b>Authorized redirect URIs</b>, add exactly:<br><code>${redirect}</code></li>
      <li>Copy the <b>Client ID</b> and <b>Client Secret</b>, paste below, and click Connect —
        you'll sign in (as the shared Tech Schedule account) and approve calendar access.</li>
    </ol>
    <form method="POST" action="/setup/google" autocomplete="off">
      <label>Google Client ID<input name="clientId" required autocomplete="off"></label>
      <label>Google Client Secret<input name="clientSecret" type="password" required autocomplete="off"></label>
      <button type="submit">Connect Google</button>
    </form>
    <p class="fine">Sign in as the account that owns/writes the Tech Schedule calendar
    (<code>notifications@fhiflorida.com</code>). The event is created there and techs are invited as guests.</p>
  `);
}

/** POST /setup/google — store client id/secret, return the Google consent URL to redirect to. */
export async function handleGoogleStart(
  env: Env,
  form: Record<string, string>,
  baseUrl: string
): Promise<string> {
  const clientId = (form.clientId ?? "").trim();
  const clientSecret = (form.clientSecret ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new SetupError("Google Client ID and Client Secret are required.");
  }
  await saveGooglePending(env, clientId, clientSecret);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(baseUrl),
    response_type: "code",
    scope: CAL_SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
    include_granted_scopes: "true",
  });
  return `${GOOGLE_AUTH_URI}?${params.toString()}`;
}

/** GET /setup/google/callback?code=... — exchange the code for a refresh token and store it. */
export async function handleGoogleCallback(env: Env, code: string, baseUrl: string): Promise<string> {
  if (!code) throw new SetupError("Missing authorization code from Google.");
  const pending = await getGooglePending(env);
  if (!pending) {
    throw new SetupError("Setup session expired. Start again from the Google section of /setup.");
  }

  const body = new URLSearchParams({
    code,
    client_id: pending.clientId,
    client_secret: pending.clientSecret,
    redirect_uri: googleRedirectUri(baseUrl),
    grant_type: "authorization_code",
  });
  const res = await fetch(env.GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!data.refresh_token) {
    throw new SetupError(
      `Google did not return a refresh token: ${JSON.stringify(data)}. ` +
        `Make sure the redirect URI is registered and try again.`
    );
  }

  await saveGoogleCreds(env, {
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    refreshToken: data.refresh_token,
  });
  _clearGoogleTokenCache();

  return page(`
    <h1 class="ok">Google connected ✓</h1>
    <p class="lead">Calendar access stored. Scheduling from a work order will now create events on
    Tech Schedule and invite the assigned techs.</p>
    <p><a href="/setup">← Back to setup</a> · <a href="/health">/health</a></p>
  `);
}

/** POST /setup — do the exchange + store. Returns a success HTML page. Throws SetupError on bad input. */
export async function handleSetupPost(
  env: Env,
  form: Record<string, string>
): Promise<string> {
  const clientId = (form.clientId ?? "").trim();
  const clientSecret = (form.clientSecret ?? "").trim();
  const code = (form.code ?? "").trim();
  const token = (form.token ?? "").trim();
  const scopes = (form.scopes ?? "").trim();

  if (!clientId || !clientSecret || !code) {
    throw new SetupError("Client ID, Client Secret, and Grant Code are all required.");
  }

  // Lock: once configured (integration_credentials), require the setup token to overwrite.
  if (await isZohoConfiguredInStore(env)) {
    if (!env.SETUP_TOKEN || token !== env.SETUP_TOKEN) {
      throw new SetupError(
        "Zoho is already configured. To reconfigure, set a SETUP_TOKEN var on the Worker and enter it in the form."
      );
    }
  }

  // Remember the entered scope so the page shows it next time (self-client: the scope is bound to
  // the grant code Craig generated in the console, not sent here — this only persists the guidance).
  if (scopes) await saveZohoScopes(env, scopes);

  const refreshToken = await exchangeCodeForRefreshToken(env, clientId, clientSecret, code);
  await saveZohoCreds(env, { clientId, clientSecret, refreshToken });
  _clearTokenCache(); // drop any stale access token so the next call uses the new creds

  return page(`
    <h1 class="ok">Zoho connected ✓</h1>
    <p class="lead">Credentials stored. The backend can now talk to Zoho Projects.</p>
    <p>Next: reload the app, or check
      <a href="/work-orders?filter=all">/work-orders</a> and <a href="/health">/health</a>.</p>
    <p class="fine">For security you can now remove or lock this page — set a <code>SETUP_TOKEN</code>
    var (any random string) so it can't be resubmitted without it.</p>
  `);
}

/** POST the authorization_code grant to Zoho and return the refresh token. */
async function exchangeCodeForRefreshToken(
  env: Env,
  clientId: string,
  clientSecret: string,
  code: string
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });
  const res = await fetch(`${env.ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    error?: string;
  };
  if (!data.refresh_token) {
    // Common: "invalid_code" (expired/already-used code) or a client id/secret mismatch.
    throw new SetupError(
      `Zoho did not return a refresh token: ${JSON.stringify(data)}. ` +
        `Usually the code expired (regenerate it) or the Client ID/Secret don't match.`
    );
  }
  return data.refresh_token;
}

//------------------------------------------------------------------------------
// Minimal FHI-branded page shell (self-contained; no external assets).
//------------------------------------------------------------------------------
function page(inner: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>FHI WO — Setup</title>
<style>
  :root{--orange:#F29922;--blue:#203070;--gray:#726E6E;--cream:#F5EFE6;--line:#E7E2D8;--ok:#2E7D5B}
  *{box-sizing:border-box}
  body{margin:0;background:var(--cream);color:#333;font-family:Inter,-apple-system,"Segoe UI",Arial,sans-serif;line-height:1.55}
  .card{max-width:560px;margin:32px auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:26px 28px;box-shadow:0 6px 24px rgba(32,48,112,.08)}
  h1{font-family:"Barlow Semi Condensed",Inter,sans-serif;color:var(--blue);margin:0 0 .3em}
  h2{font-family:"Barlow Semi Condensed",Inter,sans-serif;color:var(--blue);font-size:18px;margin:18px 0 6px;border-top:1px solid var(--line);padding-top:16px}
  h1.ok{color:var(--ok)}
  .status{display:flex;gap:8px;margin:10px 0 4px}
  .pill{font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px;border:1px solid var(--line)}
  .pill.on{background:#e5f1eb;color:#2e7d5b;border-color:#bfe0cd}
  .pill.off{background:#f5efe6;color:#726e6e}
  .lead{color:#444}.fine{font-size:12px;color:var(--gray)}
  code{background:#f3efe7;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12px;word-break:break-all}
  ol.steps{padding-left:18px}ol.steps li{margin:6px 0}
  label{display:block;font-weight:700;color:var(--blue);font-size:13px;margin:14px 0 0}
  label .hint{font-weight:400;color:var(--gray)}
  input{width:100%;margin-top:5px;padding:10px 11px;border:1px solid var(--line);border-radius:9px;font-size:15px;font-family:inherit}
  button{margin-top:18px;width:100%;background:var(--orange);color:#fff;border:0;padding:13px;border-radius:10px;font-weight:800;font-size:15px;font-family:"Barlow Semi Condensed",sans-serif;letter-spacing:.4px;cursor:pointer}
  a{color:var(--orange)}
  .warn{background:#fdf0e2;border-left:4px solid var(--orange);border-radius:8px;padding:10px 12px;margin:12px 0;font-size:14px}
  .err{background:#fbe3de;border-left:4px solid #c0492f;border-radius:8px;padding:10px 12px;margin:12px 0;font-size:14px;color:#8f2f1c}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

/** Render an error back into the form page. */
export function renderSetupError(message: string): string {
  return page(`<h1>Connect Zoho</h1>
    <div class="err">${escapeHtml(message)}</div>
    <p><a href="/setup">← Back to the form</a></p>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
