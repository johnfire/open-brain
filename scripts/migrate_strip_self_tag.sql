-- One-time data migration (spec 3.3): strip the author self-tag from
-- metadata.people on existing rows. Idempotent — re-running is a no-op.
--
-- DRY RUN: run section 1 alone first; it prints the diff without writing.

-- ── Section 1: DRY RUN ────────────────────────────────────────────────────────
-- Rows that would change, with before/after people arrays.
select
  id,
  metadata->'people' as people_before,
  (
    select coalesce(jsonb_agg(p), '[]'::jsonb)
    from jsonb_array_elements_text(metadata->'people') as p
    where lower(p) not in ('christopher rehm','chris rehm','christopher','chris','c. rehm')
  ) as people_after
from thoughts
where metadata ? 'people'
  and exists (
    select 1 from jsonb_array_elements_text(metadata->'people') as p
    where lower(p) in ('christopher rehm','chris rehm','christopher','chris','c. rehm')
  );

-- ── Section 2: WRITE ──────────────────────────────────────────────────────────
-- update thoughts
-- set metadata = jsonb_set(
--   metadata,
--   '{people}',
--   (
--     select coalesce(jsonb_agg(p), '[]'::jsonb)
--     from jsonb_array_elements_text(metadata->'people') as p
--     where lower(p) not in ('christopher rehm','chris rehm','christopher','chris','c. rehm')
--   )
-- ),
-- updated_at = now()
-- where metadata ? 'people'
--   and exists (
--     select 1 from jsonb_array_elements_text(metadata->'people') as p
--     where lower(p) in ('christopher rehm','chris rehm','christopher','chris','c. rehm')
--   );
