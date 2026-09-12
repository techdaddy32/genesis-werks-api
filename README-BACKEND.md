# Service Work Order — Backend (Cloudflare Worker)

Moved here 2026-08-24 from `fhi/projects/the-bridge/work/backend/` so the LV Plan Analyzer
conversation owns BOTH the front-end and this backend (no more cross-conversation handoffs).

## What this is
The API for the Service Work Order system — a Cloudflare Worker (TypeScript) backing the
work-order UI in the LV Plan app. It talks to Zoho Projects, Google Calendar, Zoho Cliq, and (for
invoice notes) the Anthropic API. Deploys to Cloudflare; the app deploys to Render as before. Two
deployments, one codebase home.

## First-time setup here (one-time)
This folder was copied WITHOUT `node_modules` (regenerable). In this folder run:
```
npm install
```
Then it builds/deploys exactly as before.

## Build / deploy
- Typecheck: `npx tsc --noEmit`
- Deploy: `deploy.bat` (or `npx wrangler deploy`). See `DEPLOY-CHECKLIST.md` for the full one-time
  setup (secrets, PUBLIC_WORKER_URL, ADMIN_PIN, etc.) — the path in it now points here.

## Cleanup from the move (do once, in File Explorer)
- Delete the leftover `.nm_del` folder in THIS directory (a partial node_modules the sync mount
  wouldn't let the assistant remove), then run `npm install`.
- Delete `_backups/` here if present (old backups, not needed).
- Once this location deploys cleanly, you can delete the old `the-bridge\work\backend\` folder.

## Layout
`src/` — the Worker (index.ts router; service.ts orchestration; zoho.ts / calendar.ts / cliq.ts /
ai.ts integrations; config.ts; status.ts; wonumber.ts; pdf.ts; time.ts; admin.ts; people.ts;
creds.ts; setup.ts; types.ts). `wrangler.toml` — config + vars. `test/` — mock logic tests.

## Note on the specs
The canonical spec, roadmap, and Smackdab context stay in The Bridge
(`fhi/projects/the-bridge/knowledge/` and `.../work/`). This folder is the live code only.
