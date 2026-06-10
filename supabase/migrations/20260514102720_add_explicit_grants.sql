-- ============================================================
-- Explicit grants for Supabase Data API (PostgREST)
-- Required by Supabase policy change, enforced October 30 2026
-- Covers: thoughts, thought_edges, dream_runs
-- ============================================================

-- ------------------------------------------------------------
-- GRANTS (idempotent — safe to re-run)
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.thoughts     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.thought_edges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dream_runs    TO service_role;

-- ------------------------------------------------------------
-- RLS (idempotent — enabling an already-enabled table is a no-op)
-- ------------------------------------------------------------
ALTER TABLE public.thoughts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thought_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dream_runs    ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- POLICIES (guarded — skips creation if policy already exists)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'thoughts'
    AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON public.thoughts
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'thought_edges'
    AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON public.thought_edges
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'dream_runs'
    AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON public.dream_runs
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
