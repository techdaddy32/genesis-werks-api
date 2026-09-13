-- =============================================================================
-- schema_lint.sql — plain-SQL schema checks (no pgTAP). Run after `db push`.
-- Raises an EXCEPTION on the first failure; prints NOTICEs on success.
-- Safe on prod: the sequence test runs inside a transaction that is rolled
-- back, so it leaves no rows behind.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/schema_lint.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Every domain table has the BASELINE columns and RLS enabled, with a
--    tenant_isolation policy. System tables are exempt from the column check
--    but still must have RLS.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r          record;
  v_missing  text[];
  v_system   text[] := ARRAY[
    'status_vocab', 'tenants', 'sequences', 'external_ids', 'events',
    'field_definitions', 'tenant_settings', 'users', 'user_roles', 'memberships',
    'integration_credentials'
  ];
  v_baseline text[] := ARRAY[
    'id', 'tenant_id', 'created_at', 'updated_at', 'deleted_at', 'schema_version', 'custom'
  ];
  v_domain_count int := 0;
  v_table_count  int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, c.relrowsecurity AS rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    v_table_count := v_table_count + 1;

    IF NOT r.rls THEN
      RAISE EXCEPTION 'schema_lint: table public.% has ROW LEVEL SECURITY disabled', r.tbl;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = 'tenant_isolation'
    ) THEN
      RAISE EXCEPTION 'schema_lint: table public.% has no tenant_isolation policy', r.tbl;
    END IF;

    IF r.tbl = ANY (v_system) THEN
      CONTINUE;
    END IF;

    v_domain_count := v_domain_count + 1;

    SELECT array_agg(b.col ORDER BY b.col)
      INTO v_missing
    FROM unnest(v_baseline) AS b(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = r.tbl AND ic.column_name = b.col
    );

    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'schema_lint: table public.% is missing BASELINE column(s) %', r.tbl, v_missing;
    END IF;

    -- id must default to uuidv7()
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = r.tbl AND ic.column_name = 'id'
        AND ic.column_default ILIKE '%uuidv7()%'
    ) THEN
      RAISE EXCEPTION 'schema_lint: table public.%.id does not default to uuidv7()', r.tbl;
    END IF;

    -- custom must be NOT NULL jsonb
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = r.tbl AND ic.column_name = 'custom'
        AND ic.data_type = 'jsonb' AND ic.is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'schema_lint: table public.%.custom must be jsonb NOT NULL', r.tbl;
    END IF;

    -- updated_at trigger present
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.tbl AND t.tgname = 'trg_updated_at' AND NOT t.tgisinternal
    ) THEN
      RAISE EXCEPTION 'schema_lint: table public.% has no trg_updated_at trigger', r.tbl;
    END IF;
  END LOOP;

  RAISE NOTICE 'schema_lint: % tables checked (% domain tables with BASELINE), RLS + tenant_isolation everywhere', v_table_count, v_domain_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Every status-bearing table has a trg_vocab validation trigger, and the
--    events table is immutable.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_roles', 'projects', 'work_orders', 'wo_tasks', 'items', 'todos',
    'action_items', 'forums', 'forum_comments', 'contacts', 'deals'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tr
      JOIN pg_class c ON c.oid = tr.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND tr.tgname = 'trg_vocab'
    ) THEN
      RAISE EXCEPTION 'schema_lint: table public.% has no trg_vocab trigger', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
    JOIN pg_class c ON c.oid = tr.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'events' AND tr.tgname = 'trg_events_immutable'
  ) THEN
    RAISE EXCEPTION 'schema_lint: events has no trg_events_immutable trigger';
  END IF;

  RAISE NOTICE 'schema_lint: vocab + events-immutability triggers present';
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. next_public_key(): 100 calls in ONE statement yield 100 distinct,
--    sequential values 1..100. Rolled back so nothing persists.
-- -----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_tenant   uuid;
  v_vals     int[];
  v_distinct int;
  v_key      text;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants t ORDER BY t.created_at LIMIT 1;
  IF v_tenant IS NULL THEN
    INSERT INTO public.tenants (name, slug) VALUES ('lint-tmp', 'lint-tmp') RETURNING id INTO v_tenant;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);

  -- scratch kind so the test never touches real counters
  DELETE FROM public.sequences WHERE tenant_id = v_tenant AND kind = 'lint_test';

  SELECT array_agg(s.v ORDER BY s.v)
    INTO v_vals
  FROM (
    SELECT public.next_public_key(v_tenant, 'lint_test', 'global', 2099) AS v
    FROM generate_series(1, 100)
  ) s;

  SELECT count(DISTINCT x) INTO v_distinct FROM unnest(v_vals) AS x;

  IF cardinality(v_vals) <> 100 THEN
    RAISE EXCEPTION 'schema_lint: expected 100 values from next_public_key, got %', cardinality(v_vals);
  END IF;
  IF v_distinct <> 100 THEN
    RAISE EXCEPTION 'schema_lint: next_public_key returned duplicates (% distinct of 100)', v_distinct;
  END IF;
  IF v_vals[1] <> 1 OR v_vals[100] <> 100 THEN
    RAISE EXCEPTION 'schema_lint: next_public_key values are not sequential 1..100 (first=%, last=%)', v_vals[1], v_vals[100];
  END IF;
  IF (SELECT s.next FROM public.sequences s WHERE s.tenant_id = v_tenant AND s.kind = 'lint_test' AND s.scope_key = 'global' AND s.year = 2099) <> 101 THEN
    RAISE EXCEPTION 'schema_lint: sequences.next should be 101 after 100 mints';
  END IF;

  -- mint_public_key(): pattern formatting round-trip on a scratch kind
  INSERT INTO public.tenant_settings (tenant_id, key, value)
  VALUES (v_tenant, 'numbering.lint_test', '{"pattern":"{projectKey}-WO-{YYYY}-{seq4}","scope":"global","pad":4,"yearly_reset":true}'::jsonb)
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;

  v_key := public.mint_public_key(v_tenant, 'lint_test', 'FHI-672');
  IF v_key !~ '^FHI-672-WO-\d{4}-0001$' THEN
    RAISE EXCEPTION 'schema_lint: mint_public_key produced "%" (expected FHI-672-WO-YYYY-0001)', v_key;
  END IF;

  RAISE NOTICE 'schema_lint: next_public_key 100x OK (1..100, distinct); mint_public_key -> %', v_key;
END;
$$;

ROLLBACK;

-- -----------------------------------------------------------------------------
-- 4. events immutability actually fires (rolled back).
-- -----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_tenant uuid;
  v_id     uuid;
  v_ok     boolean := false;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants t ORDER BY t.created_at LIMIT 1;
  IF v_tenant IS NULL THEN
    INSERT INTO public.tenants (name, slug) VALUES ('lint-tmp', 'lint-tmp') RETURNING id INTO v_tenant;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);

  INSERT INTO public.events (tenant_id, entity, event_type, payload, actor)
  VALUES (v_tenant, 'lint', 'lint.test', '{}', 'system:lint') RETURNING id INTO v_id;

  BEGIN
    UPDATE public.events SET actor = 'x' WHERE id = v_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'schema_lint: events UPDATE was not blocked';
  END IF;

  v_ok := false;
  BEGIN
    DELETE FROM public.events WHERE id = v_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'schema_lint: events DELETE was not blocked';
  END IF;

  RAISE NOTICE 'schema_lint: events is append-only (UPDATE/DELETE blocked)';
END;
$$;

ROLLBACK;

SELECT 'schema_lint: ALL CHECKS PASSED' AS result;
