//==============================================================================
// calendar.ts — Google Calendar (v3) client.
//
// Model (per spec): create ONE event and add techs as GUESTS (attendees), rather
// than putting a copy on each tech's calendar. A single event with attendees
// shows up on every guest's calendar while remaining one source event — so a
// reschedule is a single edit, and two-way sync has one object to reconcile.
//
// Auth is configurable (config.googleAuthMethod):
//   - service_account (DEFAULT): a GCP service account with domain-wide delegation
//     signs a JWT and exchanges it for an access token, impersonating GOOGLE_SA_SUBJECT.
//     Requires scope https://www.googleapis.com/auth/calendar.
//   - oauth_user (ALTERNATIVE): a single shared Google user's refresh token is
//     exchanged for an access token. Simpler to set up, but every event is owned
//     by that one user.
//
// No secret is hardcoded; all key material comes from env.
//==============================================================================

import type { Env, Schedule } from "./types";
import { googleAuthMethod } from "./config";
import { getGoogleCreds } from "./creds";

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar";

//------------------------------------------------------------------------------
// Access-token acquisition (in-memory cache, same rationale as zoho.ts).
//------------------------------------------------------------------------------
interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
let tokenCache: CachedToken | null = null;
const TOKEN_SKEW_MS = 60_000;

export async function getGoogleAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_SKEW_MS > now) {
    return tokenCache.accessToken;
  }

  const token =
    googleAuthMethod(env) === "oauth_user"
      ? await getTokenViaOAuthUser(env)
      : await getTokenViaServiceAccount(env);

  tokenCache = { accessToken: token.accessToken, expiresAt: now + token.ttlMs };
  return token.accessToken;
}

export function _clearGoogleTokenCache(): void {
  tokenCache = null;
}

/** Method B — exchange a shared user's refresh token. */
async function getTokenViaOAuthUser(env: Env): Promise<{ accessToken: string; ttlMs: number }> {
  // Creds come from KV (written by the /setup Google flow) first, then env secrets.
  const creds = await getGoogleCreds(env);
  if (!creds) {
    throw new CalendarError(
      "Google is not connected yet — open /setup and complete the Google Calendar section."
    );
  }
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(env.GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new CalendarError(`Google OAuth refresh failed: ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: j.access_token, ttlMs: (j.expires_in ?? 3600) * 1000 };
}

/** Method A — sign a JWT with the service-account key and exchange it (domain-wide delegation). */
async function getTokenViaServiceAccount(env: Env): Promise<{ accessToken: string; ttlMs: number }> {
  if (!env.GOOGLE_SA_CLIENT_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY || !env.GOOGLE_SA_SUBJECT) {
    throw new CalendarError(
      "GOOGLE_AUTH_METHOD=service_account but GOOGLE_SA_CLIENT_EMAIL/PRIVATE_KEY/SUBJECT are not all set."
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.GOOGLE_SA_CLIENT_EMAIL,
    sub: env.GOOGLE_SA_SUBJECT, // impersonated user (domain-wide delegation)
    scope: CAL_SCOPE,
    aud: env.GOOGLE_TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await signRs256(unsigned, env.GOOGLE_SA_PRIVATE_KEY);
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetch(env.GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new CalendarError(`Google SA token exchange failed: ${res.status} ${await safeText(res)}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: j.access_token, ttlMs: (j.expires_in ?? 3600) * 1000 };
}

//------------------------------------------------------------------------------
// Event body builder.
//------------------------------------------------------------------------------
export interface EventBodyInput {
  fullWoNumber: string;
  client: string;
  subject: string;
  siteAddress: string | null;
  notes: string | null;
  accessCodesText?: string | null; // pre-formatted "Gate: 1234 / Door: 5678"
  woLink?: string | null;          // deep link back to the WO in the app
  start: string;                   // ISO 8601
  end: string;                     // ISO 8601
  attendees: string[];             // tech emails invited as guests
  tentative?: boolean;             // prepend a bold TENTATIVE line to the description
}

/** HTML-escape text content for the Google event description (which accepts HTML). */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Escape a URL for use inside an href="" attribute. */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
/** The short WO portion (WO-YYYY-####) pulled from the full composite number. */
function shortWoNumber(fullWoNumber: string): string {
  return fullWoNumber.match(/WO-\d{4}-\d+/i)?.[0] ?? fullWoNumber;
}

/** Build the Google event resource. Title: `{fullWO} — {client} — {subject}`. */
export function buildEventBody(input: EventBodyInput): Record<string, unknown> {
  // Google Calendar descriptions accept a small HTML subset, so the work-order link
  // renders as a CLICKABLE hyperlink with readable text — "{client} · {shortWO} - {subject}"
  // — instead of a raw URL. (The event TITLE can't be a link, so it stays plain.)
  const descParts: string[] = [];
  if (input.tentative) descParts.push("<b>TENTATIVE — pending confirmation</b>");
  if (input.woLink) {
    const linkText = `${input.client} · ${shortWoNumber(input.fullWoNumber)} - ${input.subject}`;
    descParts.push(`<a href="${escAttr(input.woLink)}">${escHtml(linkText)}</a>`);
  } else {
    descParts.push(escHtml(`WO#: ${input.fullWoNumber}`));
  }
  if (input.notes) descParts.push(escHtml(input.notes).replace(/\n/g, "<br>"));
  if (input.accessCodesText) descParts.push(escHtml(`Access codes: ${input.accessCodesText}`));

  return {
    summary: `${input.tentative ? "TENTATIVE — " : ""}${input.fullWoNumber} — ${input.client} — ${input.subject}`,
    location: input.siteAddress ?? undefined,
    description: descParts.join("<br><br>"),
    start: { dateTime: input.start },
    end: { dateTime: input.end },
    attendees: input.attendees.map((email) => ({ email })),
    // Store the WO number on the event too, so the reconcile can join event->WO
    // without parsing the summary.
    extendedProperties: { private: { fhiWoNumber: input.fullWoNumber } },
  };
}

//------------------------------------------------------------------------------
// CRUD helpers.
//------------------------------------------------------------------------------
export interface GoogleEvent {
  id: string;
  status: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string; responseStatus?: string }>;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

function calBase(env: Env, calendarId: string): string {
  return `${env.GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
}

async function calFetch(env: Env, url: string, init: RequestInit = {}): Promise<any> {
  const token = await getGoogleAccessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new CalendarError(`Google Calendar ${init.method ?? "GET"} failed: ${res.status} ${await safeText(res)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** Insert an event. `sendUpdates=all` so guests get invites. */
export async function insertEvent(
  env: Env,
  calendarId: string,
  body: Record<string, unknown>
): Promise<GoogleEvent> {
  const url = `${calBase(env, calendarId)}?sendUpdates=all`;
  return (await calFetch(env, url, { method: "POST", body: JSON.stringify(body) })) as GoogleEvent;
}

/** Patch (partial update) an event — used for reschedules / attendee changes. */
export async function patchEvent(
  env: Env,
  calendarId: string,
  eventId: string,
  patch: Record<string, unknown>
): Promise<GoogleEvent> {
  const url = `${calBase(env, calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=all`;
  return (await calFetch(env, url, { method: "PATCH", body: JSON.stringify(patch) })) as GoogleEvent;
}

/** Get a single event. */
export async function getEvent(env: Env, calendarId: string, eventId: string): Promise<GoogleEvent> {
  return (await calFetch(env, `${calBase(env, calendarId)}/${encodeURIComponent(eventId)}`)) as GoogleEvent;
}

/**
 * Delete an event (used when a visit is removed). Idempotent: a 404/410 means the
 * event is already gone, which we treat as success. `sendUpdates=all` so guests are
 * notified of the cancellation. Uses a raw fetch (not calFetch) because calFetch
 * throws on any non-2xx and we need to swallow the already-gone statuses.
 */
export async function deleteEvent(env: Env, calendarId: string, eventId: string): Promise<void> {
  const url = `${calBase(env, calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=all`;
  const token = await getGoogleAccessToken(env);
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new CalendarError(`Google Calendar DELETE failed: ${res.status} ${await safeText(res)}`);
  }
}

/**
 * List events changed since `updatedMin` (ISO). Used by the reconcile to find
 * reschedules made directly on the calendar.
 */
export async function listEvents(
  env: Env,
  calendarId: string,
  opts: { updatedMin?: string; maxResults?: number } = {}
): Promise<GoogleEvent[]> {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "updated",
    maxResults: String(opts.maxResults ?? 250),
    showDeleted: "true",
  });
  if (opts.updatedMin) params.set("updatedMin", opts.updatedMin);
  const url = `${calBase(env, calendarId)}?${params.toString()}`;
  const data = await calFetch(env, url);
  return (data.items ?? []) as GoogleEvent[];
}

/** Convenience: turn a GoogleEvent into the WO Schedule shape. */
export function toSchedule(calendarId: string, ev: GoogleEvent | null): Schedule {
  if (!ev) {
    return { calendarId, eventId: null, start: null, end: null, attendees: [], htmlLink: null };
  }
  return {
    calendarId,
    eventId: ev.id,
    start: ev.start?.dateTime ?? ev.start?.date ?? null,
    end: ev.end?.dateTime ?? ev.end?.date ?? null,
    attendees: (ev.attendees ?? []).map((a) => a.email),
    htmlLink: ev.htmlLink ?? null,
  };
}

//------------------------------------------------------------------------------
// RS256 signing via WebCrypto (needs a PEM PKCS#8 private key from the SA JSON).
//------------------------------------------------------------------------------
async function signRs256(data: string, pemPrivateKey: string): Promise<string> {
  const key = await importPkcs8(pemPrivateKey);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(data)
  );
  return b64urlBytes(new Uint8Array(sig));
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  // Accept keys with literal "\n" (as stored in env) or real newlines.
  const normalized = pem.replace(/\\n/g, "\n");
  const b64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(b64);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

//------------------------------------------------------------------------------
// base64url helpers.
//------------------------------------------------------------------------------
function b64url(str: string): string {
  return b64urlBytes(new TextEncoder().encode(str));
}
function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}
