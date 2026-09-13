# Deploy checklist — FHI Service Work Order backend

Plain-language, in order. This deploys the Cloudflare Worker that the LV Plan app calls.
You run these on your Windows machine, in **this `backend` folder**.

---

## 0. Open a terminal in this folder (use cmd, NOT PowerShell)
PowerShell blocks npm's scripts on this machine. Use Command Prompt instead:
- In File Explorer, open this `backend` folder.
- Click the address bar, type **`cmd`**, press **Enter**. A black window opens, already in this folder.

*(If you insist on PowerShell, first run once: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`, answer `Y`.)*

---

## 1. One-time setup
```
npm install
npx wrangler login
```
- `npm install` downloads the code's dependencies (takes a minute; only needed once).
- `wrangler login` opens a browser to connect your Cloudflare account. Approve it.

---

## 2. First deploy (creates the Worker)
```
npx wrangler deploy
```
When it finishes it prints a URL like `https://fhi-service-wo.<your-subdomain>.workers.dev`.
**Copy that URL** — it's the backend address the LV Plan app will point at.

---

## 3a. Connect Zoho — the EASY way, in your browser (no terminal)
After the deploy in step 2, just open this page and fill in the form:
```
https://fhi-service-wo.<your-subdomain>.workers.dev/setup
```
It tells you exactly what to do: in the Zoho API Console, open your **Self Client → Generate Code**
(scope `ZohoProjects.portals.READ,ZohoProjects.projects.ALL,ZohoProjects.tasklists.ALL,ZohoProjects.tasks.ALL`,
10-minute duration), copy the **code** plus your **Client ID/Secret**, paste all three into the form,
and submit. The Worker does the token exchange and stores it. No `wrangler secret put`, no curl.

*(This replaces setting `ZOHO_*` secrets by hand. If you'd rather use the CLI, the three commands are
`npx wrangler secret put ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN`.)*

## 3a′. Set the credentials key (CLI — one command, F3)
The /setup page stores the Zoho/Google OAuth material encrypted in Postgres. It needs a key:
```
npx wrangler secret put CREDS_KEY
```
Paste the output of `openssl rand -base64 32` (any 32 random bytes, base64). Without it /setup shows
an error on save and the Worker falls back to the `ZOHO_*` / `GOOGLE_OAUTH_*` secrets.

## 3b. Set the Google secrets (CLI — three commands)
Run each line, then paste the matching value at the **"Enter a secret value:"** prompt. Use the NEW
values (after you reset the secret). The name after `put` is a fixed slot — never put the secret on the line.
```
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
```

Then redeploy so the Google secrets take effect:
```
npx wrangler deploy
```
*(Zoho set via /setup in 3a needs no redeploy — it's stored live.)*

---

## 3c. One-time: move the KV data into Postgres (F3 cutover)
Do this ONCE, before the first deploy of the no-KV build, from this folder (full detail: RUNBOOK.md → "F3 cutover"):
```
npx tsx scripts/import-kv.ts --dump --out kv-dump.json --worker-url https://<your-live-worker>.workers.dev
set DATABASE_URL=postgres://genesis_api:<password>@<supabase-pooler-host>:5432/postgres
set CREDS_KEY=<the same value you gave wrangler secret put CREDS_KEY>
npx tsx scripts/import-kv.ts --from-dump kv-dump.json --dry-run
npx tsx scripts/import-kv.ts --from-dump kv-dump.json
```
The last command prints a table of what was loaded (technicians, people, hours, daily reports, reminders,
admin config, the WO counter). Re-running it is safe. Then `npx wrangler deploy`. The old KV namespace is
never written again; delete it once you have verified the app for a week.

## 4. Check it's alive
Open this in a browser (use your Worker URL from step 2):
```
https://fhi-service-wo.<your-subdomain>.workers.dev/health
```
You should see JSON with `"ok": true` and `"woFieldConfigured": true`.

---

## Already done for you (nothing to do)
These are set in `wrangler.toml`:
- Hyperdrive + R2 bindings (no KV since F3) · `ZOHO_WO_FIELD = work_order_hash`
- `GOOGLE_AUTH_METHOD = oauth_user` · `DEFAULT_CALENDAR_ID = notifications@fhiflorida.com`
- `APP_ORIGIN = https://fhi-plan-markup.onrender.com` · `WO_SEQUENCE_SCOPE = global`

## Still to confirm at deploy time
- The Zoho secret values live on your laptop (see `../../knowledge/secrets-location.md`); rotate if needed.
- Point the LV Plan app's API base at the Worker URL from step 2.

---

## If something errors
- **`running scripts is disabled`** → you're in PowerShell; use cmd (step 0).
- **`/health` shows `woFieldConfigured: false`** → `ZOHO_WO_FIELD` isn't set; it's `work_order_hash` in `wrangler.toml`, redeploy.
- **App calls blocked (CORS)** → `APP_ORIGIN` must exactly match the app's URL (no trailing slash).
- **Calendar errors** → recheck the three `GOOGLE_OAUTH_*` secrets; regenerate the refresh token in the OAuth Playground if needed.
