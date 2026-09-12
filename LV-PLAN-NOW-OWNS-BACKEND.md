# For the LV Plan conversation — you now own the Service Work Order backend

Paste into the LV Plan Analyzer conversation.

---

Heads up: the FHI Service Work Order **backend** (a Cloudflare Worker) now lives in this project so
you own both the app UI and the API — no more handing prompts to a separate backend conversation.

**Location:** `dev-projects/service-work-orders/backend/` (under the LV Plan Analyzer venture).

**What it is:** a TypeScript Cloudflare Worker that backs the work-order UI. It integrates Zoho
Projects, Google Calendar, Zoho Cliq, and the Anthropic API (invoice notes). It deploys to
Cloudflare; the app still deploys to Render. Two deployments, one codebase home.

**One-time setup (the folder came without node_modules):**
1. In File Explorer, delete the leftover `backend/.nm_del` folder and `backend/_backups` (a broken
   partial install the move couldn't clean).
2. Open Command Prompt in `backend/` and run `npm install`.
3. Confirm it builds: `npx tsc --noEmit` (expect 0 errors).

**Deploy:** `deploy.bat` (or `npx wrangler deploy`). Full one-time secrets/vars setup is in
`backend/DEPLOY-CHECKLIST.md` (ANTHROPIC_API_KEY, CLIQ webhooks, PUBLIC_WORKER_URL, ADMIN_PIN, and
the Zoho field vars). The Worker's deployed URL and all `wrangler.toml` vars carry over unchanged.

**Working rules:**
- Only ONE session edits this backend at a time (concurrent editing caused collisions before).
- The canonical **specs, roadmap, and Smackdab context** stay in The Bridge
  (`fhi/projects/the-bridge/`). This folder is live code only — read the spec there, build here.
- `backend/README-BACKEND.md` has the module layout.

There are pending deploys from recent fixes (subtask discriminators, visit description cleanup,
calendar link text) — do the `npm install` + delete steps above, then `deploy.bat` to ship them.
