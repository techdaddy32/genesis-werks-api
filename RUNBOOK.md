# Genesis Werks — genesis-api Runbook

_Started 2026-09-12 (G0). Operations reference for the Horizon suite backend (the Cloudflare Worker formerly `fhi-service-wo`; FHI = tenant #1). Spec + run-list: `spaces/business/ventures/fhi/projects/the-bridge/work/pipeline/2026-09-12-suite-own-database-*`._
(the Cloudflare Worker formerly `fhi-service-wo`). Spec: `../pipeline/2026-09-12-suite-own-database-design-spec.md`.
Run-list: `../pipeline/2026-09-12-suite-own-database-run-list.md`._

## Services (state as of G0)
| Service | Name / id | Status | Notes |
|---|---|---|---|
| Cloudflare Worker | `fhi-service-wo` (tag 4facd933ce414964b4ab52e09ba37bed) | LIVE | to be renamed `genesis-api` at F2 (rename = new Worker name in wrangler.toml; keep old route until LV Plan points at the new URL) |
| Cloudflare KV | `WO_KV` aaeba18d5652455496657aa231210af4 | RETIRED at F3 (2026-09-13) — read-only history, NOT bound | was counter, technicians, people, hours, daily reports, reminders, admin config, /setup creds, caches. Read once by `scripts/import-kv.ts`; delete the namespace after the cutover is verified |
| Cloudflare R2 | `genesis-files` (ENAM, Standard) | CREATED 2026-09-12 (replaces the empty `suite-files`, deleted) | plan images / photos / PDFs; enable versioning (dashboard → bucket → Settings) |
| Cloudflare R2 | `fhi-site-photos` (pre-existing, 2026-08-29) | LIVE | F-85 hub photo store — decide at P3a whether to merge into `genesis-files` or keep |
| Cloudflare Hyperdrive | `genesis-db` id e33320e5f0794cbcacc064365b305746 → Supabase session pooler aws-0-us-east-1:5432 | CREATED 2026-09-13 | binding HYPERDRIVE in wrangler.toml |
| Supabase | org "Horizon Technology Firm" · project `genesis-werks-prod`, ref gckxsyiuskifjhseuefg, us-east-1 | CREATED 2026-09-13 | connection string + service key in the secrets location (never here) |
| GitHub | https://github.com/techdaddy32/genesis-werks-api (personal account; transfer to a Horizon org later if one is created) | PUSHED 2026-09-13 | main tracks origin/main |
| Google Calendar | `notifications@fhiflorida.com` (Tech Schedule) | LIVE | unchanged |
| Zoho Projects / CRM | portal 705869960 | LIVE (system of record until each module's cutover) | |

## Where secrets live
Never in this repo or the vault. See `the-bridge/knowledge/secrets-location.md` for the physical location.
Worker secrets are set with `npx wrangler secret put <NAME>` from this folder (cmd, not PowerShell).
Planned additions: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `POSTMARK_TOKEN` (P4c), `BOOKS_*` (P7).

### Added at F2 (2026-09-13)
| Name | Kind | Where | Purpose |
|---|---|---|---|
| `HYPERDRIVE` | binding | wrangler.toml `[[hyperdrive]]` (id e33320e5…) | Postgres transport for `src/db.ts` (`prepare:false`, `max:5`, `fetch_types:false`) |
| `TENANT_ID` | var | wrangler.toml `[vars]` | tenant served by this deployment (FHI `f4100000-0000-4000-8000-000000000001`); bound per transaction with `SET LOCAL app.tenant_id` |
| `ALLOW_TENANT_HEADER` | var | NEVER in prod; `.dev.vars` only | `true` lets `X-Tenant-Id` override `TENANT_ID` (dev/test) |
| `INTERNAL_TOKEN` | secret | `npx wrangler secret put INTERNAL_TOKEN` | shared secret (header `X-Internal-Token`) for `POST /internal/events/fanout`, the Supabase DB-webhook receiver (stub in F2). Route answers 503 until set. Use the SAME value in the Supabase webhook's HTTP headers |
| `DATABASE_URL` | local only | `.dev.vars` / `TEST_DATABASE_URL` | direct `postgres://` URL used ONLY when `HYPERDRIVE` is absent (vitest, local dev). Never set in prod |
| `genesis_api` DB role | Postgres | Supabase SQL editor: `ALTER ROLE genesis_api LOGIN PASSWORD '…'` | NOBYPASSRLS role the Worker must connect as (via Hyperdrive) so `tenant_isolation` RLS applies. `postgres`/`service_role` BYPASS RLS |

Health: `GET /health` now also returns `db: {ok, latencyMs, via}` and `tenant` (additive fields).

### Added at F3 (2026-09-13) — KV retired
| Name | Kind | Where | Purpose |
|---|---|---|---|
| `CREDS_KEY` | secret | `npx wrangler secret put CREDS_KEY` (base64 of 32 random bytes: `openssl rand -base64 32`) | AES-256-GCM key for `integration_credentials` — the /setup-stored Zoho + Google OAuth material (was KV `zoho_creds` / `google_creds`). Without it /setup cannot persist; the `ZOHO_*` / `GOOGLE_OAUTH_*` secrets are used instead. Rotating it = re-run /setup (or re-import) |
| `LEGACY_WO_KV` | (not bound) | wrangler.toml commented block | the retired namespace id, documented only. `Env.LEGACY_WO_KV?` is an optional type slot nothing in `src/` uses; both go away after cutover |
| `LEGACY_WO_KV_ID`, `GENESIS_API_URL` | local env for `scripts/import-kv.ts` | Craig's machine only | namespace to read; Worker URL whose `GET /work-orders` supplies WO number/project for the shadow rows |
| `WO_SEQUENCE_SCOPE` | var | wrangler.toml | now echo-only on `/health`; the authoritative scope/pattern is `tenant_settings numbering.work_order` |

## F3 cutover — KV → Postgres (one-time, in this order)
Everything below runs from this folder on Craig's machine (cmd). The live Worker keeps serving from KV until step 4; the import only READS KV.

1. **Prereqs**: `npm install` (adds `tsx`); `npx wrangler login`; the Supabase connection string as `DATABASE_URL`
   (session pooler, as `genesis_api` or `postgres`); optionally `CREDS_KEY` (same value you will `wrangler secret put`).
2. **Snapshot KV** (read-only; also pulls the WO list from the LIVE Worker so hours/daily rows get real WO refs):
   ```
   npx tsx scripts/import-kv.ts --dump --out kv-dump.json --worker-url https://<live-worker>.workers.dev
   ```
   Keep `kv-dump.json` with the secrets (it contains the /setup credentials in clear).
3. **Dry run, then load** (re-runnable — every object upserts by natural key; the summary table lists counts per object, skipped, errors):
   ```
   set DATABASE_URL=postgres://genesis_api:<pw>@<pooler-host>:5432/postgres
   set CREDS_KEY=<base64 key>
   npx tsx scripts/import-kv.ts --from-dump kv-dump.json --dry-run
   npx tsx scripts/import-kv.ts --from-dump kv-dump.json
   ```
   Check: `sequences` row `work_order / global / 2026` has `next = <KV wo_seq:2026:__global__> + 1`; technicians/people counts match the app.
4. **Deploy genesis-api** (this commit — no `WO_KV` binding): `npx wrangler secret put CREDS_KEY` then `npx wrangler deploy`.
5. **Verify**: `GET /health` → `db.ok: true`; `GET /technicians`, `GET /people` show the imported lists; open a WO → hours + daily-report days present;
   create one WO → its number is the next sequence (0042 if KV held 41); `/setup` shows Zoho/Google as configured.
6. **KV becomes read-only history.** Nothing writes it any more. Keep the namespace for a week as a fallback (redeploying the previous commit re-binds it), then delete it
   (`npx wrangler kv namespace delete --namespace-id=aaeba18d5652455496657aa231210af4`) and remove the `LEGACY_WO_KV` comment + `Env.LEGACY_WO_KV?`.

Rollback: redeploy the previous commit (KV binding returns; the KV data was never modified). Anything written to Postgres after the cutover would need re-keying by hand.

## Tenants
| Tenant | uuid | slug | Purpose |
|---|---|---|---|
| FHI Florida | `f4100000-0000-4000-8000-000000000001` | `fhi` | production tenant (0002_seed_fhi.sql); `TENANT_ID` in wrangler.toml |
| Genesis Sandbox | `f4100000-0000-4000-8000-000000000002` | `sandbox` | SB1 (2026-09-13): fictional play tenant seeded by `supabase/migrations/0003_seed_sandbox.sql`; safe on prod (touches only its own rows). Wipe + reseed: `DATABASE_URL=<owner url> npx tsx scripts/reset-sandbox.ts` (`--counts`, `--wipe-only`, `--i-know` when the DB name contains `prod`). Serve it with `TENANT_ID=f4100000-0000-4000-8000-000000000002` on a separate Worker/preview, never by changing the FHI deployment's var. |

## Deploy
`npx wrangler deploy` from this folder on Craig's machine. Full steps: `DEPLOY.md` (to be rewritten at OPS2).

## Git
Repo root = this folder. Commit after every run-list row; push to GitHub `main`.
Do NOT commit: `.dev.vars`, `_backups/`, `*.bak`, `*.timestamp-*.mjs` (all git-ignored).

## Restore drills
| Date | What | Duration | Result |
|---|---|---|---|
| — | (OPS1 — before P2-CUT) | | |
