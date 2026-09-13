# Genesis Werks — Supabase migrations (row F1)

What is here:

| path | purpose |
|---|---|
| `migrations/0001_baseline.sql` | Schema: extensions, `uuidv7()`, system tables, every domain table, vocab-validation + `updated_at` + events-immutability triggers, RLS on every table, key minting (`next_public_key`, `mint_public_key`), derived views (`v_*`), indexes, comments, the `genesis_api` role. |
| `migrations/0002_seed_fhi.sql` | The FHI tenant, its default calendar, `tenant_settings` (from `wrangler-vars.txt` + numbering patterns), every `status_vocab` domain. |
| `tests/schema_lint.sql` | Plain-SQL checks (no pgTAP): BASELINE columns + RLS on every table, triggers present, `next_public_key` 100× distinct/sequential, `mint_public_key` formatting, events append-only. |

Both migrations are idempotent (re-running them is safe). They were applied end-to-end on a local PostgreSQL 16 (single transaction, then re-applied, then the lint) before being handed over — but they have **not** been run against the real Supabase project. That is the step below.

---

## Apply from Windows (cmd)

Prerequisites: Node 18+ and the project ref `gckxsyiuskifjhseuefg`.

```cmd
cd B:\path\to\genesis-werks
npm i -D supabase
npx supabase login
npx supabase link --project-ref gckxsyiuskifjhseuefg
```

`link` asks for the database password once and caches it locally. **Never commit the DB password** — it is not in any file here, and `supabase\.temp\` and `.env*` must be in `.gitignore`.

Dry-run first (prints the SQL it would apply, touches nothing):

```cmd
npx supabase db push --dry-run
```

Apply:

```cmd
npx supabase db push
```

`db push` applies every file in `supabase\migrations\` that is not yet recorded in `supabase_migrations.schema_migrations`, in filename order, each inside its own transaction. If `0001` fails nothing from it is kept.

## Run the lint

Option A — psql (recommended; ships with any Postgres install, or use the one inside Supabase's Docker image). Connection string is in the dashboard under *Project Settings → Database → Connection string (URI)*; put the password in an env var, not on the command line history:

```cmd
set PGPASSWORD=<db password>
psql "postgresql://postgres.gckxsyiuskifjhseuefg@aws-0-us-east-1.pooler.supabase.com:5432/postgres" -v ON_ERROR_STOP=1 -f supabase\tests\schema_lint.sql
set PGPASSWORD=
```

Use the **session** pooler (port 5432) or the direct host, not the transaction pooler (6543): the lint uses `BEGIN … ROLLBACK` blocks and `set_config`, which need a stable session.

Option B — Supabase CLI, if your CLI version has `db query` (v1.200+):

```cmd
npx supabase db query -f supabase\tests\schema_lint.sql
```

Option C — paste the file into the dashboard SQL editor. It runs as `postgres`; the `NOTICE` lines appear under *Messages*.

Expected output ends with `schema_lint: ALL CHECKS PASSED`. Any failure is a `RAISE EXCEPTION` naming the table/column.

## After applying — one manual step

`0001` creates a `genesis_api` role with `NOBYPASSRLS` so tenant isolation actually applies to the API (Supabase's `postgres` and `service_role` bypass RLS). Give it a login password out-of-band (SQL editor, never in a migration):

```sql
ALTER ROLE genesis_api LOGIN PASSWORD '<generate a long one>';
```

genesis-api then connects as `genesis_api` and starts every transaction with:

```sql
SET LOCAL app.tenant_id = 'f4100000-0000-4000-8000-000000000001';
```

(or `SELECT set_config('app.tenant_id', $1, true)`). Without it every domain query returns zero rows and every insert is refused — which is the point.

## Roll back

There is no down-migration. Two situations:

**Scratch / staging project, no real data yet** — wipe and reapply:

```sql
-- in the SQL editor of the SCRATCH project only
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role;
DELETE FROM supabase_migrations.schema_migrations;
```

then `npx supabase db push` again. (`npx supabase db reset --linked` does the same thing in one command on newer CLIs — it asks for confirmation.)

**Production after data exists** — never drop. Write a new forward migration (`0003_*.sql`) that alters what needs altering. Soft-delete columns (`deleted_at`) and `_archive` conventions mean nothing has to be destroyed to be undone.

## Adding the next migration

```cmd
npx supabase migration new <short_name>
```

creates `supabase\migrations\<timestamp>_<short_name>.sql`. Keep the rules from `0001`: BASELINE columns on every domain table, RLS + `tenant_isolation`, status columns as `text` validated by `trg_assert_vocab`, foreign ids in `external_ids`, no enums, no business-rule triggers. Run `tests\schema_lint.sql` after every push — it will fail on any table that breaks those rules.
