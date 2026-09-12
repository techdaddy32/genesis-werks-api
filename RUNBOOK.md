# suite-api — Runbook

_Started 2026-09-12 (G0). Operations reference for the Horizon suite backend (the Cloudflare Worker formerly `fhi-service-wo`; FHI = tenant #1). Spec + run-list: `spaces/business/ventures/fhi/projects/the-bridge/work/pipeline/2026-09-12-suite-own-database-*`._
(the Cloudflare Worker formerly `fhi-service-wo`). Spec: `../pipeline/2026-09-12-suite-own-database-design-spec.md`.
Run-list: `../pipeline/2026-09-12-suite-own-database-run-list.md`._

## Services (state as of G0)
| Service | Name / id | Status | Notes |
|---|---|---|---|
| Cloudflare Worker | `fhi-service-wo` (tag 4facd933ce414964b4ab52e09ba37bed) | LIVE | to be renamed `suite-api` at F2 (rename = new Worker name in wrangler.toml; keep old route until LV Plan points at the new URL) |
| Cloudflare KV | `WO_KV` aaeba18d5652455496657aa231210af4 | LIVE, to be retired at F3 | counter, technicians, hours, daily-report entries |
| Cloudflare R2 | `suite-files` (ENAM, Standard) | CREATED 2026-09-12 | plan images / photos / PDFs; enable versioning (dashboard → bucket → Settings) |
| Cloudflare R2 | `fhi-site-photos` (pre-existing, 2026-08-29) | LIVE | F-85 hub photo store — decide at P3a whether to merge into `suite-files` or keep |
| Cloudflare Hyperdrive | — | NOT YET | create after the Supabase project exists (needs its pooler connection string) |
| Supabase | org "Horizon" · project `suite-prod` | NOT YET | Craig creates (see below) |
| GitHub | `horizon-suite-api` (working name) | NOT YET | repo initialized 2026-09-12 at horizon/projects/suite-api/code from the LIVE code (lv-plan-analyzer/dev-projects/service-work-orders/backend) |
| Google Calendar | `notifications@fhiflorida.com` (Tech Schedule) | LIVE | unchanged |
| Zoho Projects / CRM | portal 705869960 | LIVE (system of record until each module's cutover) | |

## Where secrets live
Never in this repo or the vault. See `the-bridge/knowledge/secrets-location.md` for the physical location.
Worker secrets are set with `npx wrangler secret put <NAME>` from this folder (cmd, not PowerShell).
Planned additions: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `POSTMARK_TOKEN` (P4c), `BOOKS_*` (P7).

## Deploy
`npx wrangler deploy` from this folder on Craig's machine. Full steps: `DEPLOY.md` (to be rewritten at OPS2).

## Git
Repo root = this folder. Commit after every run-list row; push to GitHub `main`.
Do NOT commit: `.dev.vars`, `_backups/`, `*.bak`, `*.timestamp-*.mjs` (all git-ignored).

## Restore drills
| Date | What | Duration | Result |
|---|---|---|---|
| — | (OPS1 — before P2-CUT) | | |
