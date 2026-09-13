-- =============================================================================
-- 0004_backend_mode.sql — which store serves the domain routes per tenant (P2).
--
--   tenant_settings `backend.mode` ∈ "postgres" | "zoho"
--     FHI     (…0001) → "zoho"      : work orders / projects / items / todos /
--                                     materials / visits still live in Zoho until
--                                     the P3a import + cutover (flip this row then).
--     sandbox (…0002) → "postgres"  : has no Zoho at all; every domain route is
--                                     served from the 0001 tables/views.
--
-- genesis-api reads the key once per request (src/backend-mode.ts); an absent
-- key or any other value means "zoho". Idempotent: re-running keeps whatever
-- value the row already holds (ON CONFLICT DO NOTHING) so a cutover flip is
-- never reverted by a re-apply. 0003_seed_sandbox.sql (re-run by
-- scripts/reset-sandbox.ts) also upserts the sandbox row, so a sandbox reset
-- keeps it in Postgres mode.
-- =============================================================================

INSERT INTO public.tenant_settings (tenant_id, key, value) VALUES
  ('f4100000-0000-4000-8000-000000000001', 'backend.mode', to_jsonb('zoho'::text)),
  ('f4100000-0000-4000-8000-000000000002', 'backend.mode', to_jsonb('postgres'::text))
ON CONFLICT (tenant_id, key) DO NOTHING;
