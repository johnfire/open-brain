-- One-time topic remap (spec 3.3) — DO NOT RUN until the vocabulary in
-- docs/TOPIC_CONSOLIDATION_PROPOSAL.md is approved. Idempotent.
--
-- The remap table mirrors the approved proposal; edit it there first if the
-- approved list differs.

-- ── Section 1: DRY RUN — prints before/after topics for every affected row ───
with remap(old, new) as (
  values
    ('Open Brain','open-brain'),('MCP server','open-brain'),('MCP tools','open-brain'),
    ('cognitive architecture','open-brain'),
    ('art marketing','art-business'),('gallery outreach','art-business'),('art venues','art-business'),
    ('watercolor painting','art-practice'),('art','art-practice'),
    ('art-platform','leguilde'),
    ('rehm-consulting','consultancy'),('consultancy launch','consultancy'),
    ('business strategy','consultancy'),('self-employment','consultancy'),
    ('Gründungszuschuss','gz-application'),('ATS optimization','gz-application'),('ATS','gz-application'),
    ('CV optimization','gz-application'),('CV generation','gz-application'),('resume writing','gz-application'),
    ('career development','gz-application'),('ALG I','gz-application'),
    ('Claude Code','claude-code'),('Claude workflow','claude-code'),('AI agents','claude-code'),
    ('automation','claude-code'),
    ('web development','engineering'),('CI/CD','engineering'),('software development','engineering'),
    ('testing','engineering'),('architecture','engineering'),('Python','engineering'),
    ('React','engineering'),('Kotlin','engineering'),('Supabase','engineering'),('Ubuntu','engineering'),
    ('international relations','geopolitics'),
    ('geopolitical simulation','geopolitical-sim'),
    ('AI alignment','philosophy'),('AGI','philosophy'),('decision making','philosophy'),
    ('Theo van Gogh','theo-van-gogh'),
    ('Grendel','grendel'),('Grendel project','grendel')
)
select t.id,
  t.metadata->'topics' as topics_before,
  (
    select jsonb_agg(distinct coalesce(r.new, p))
    from jsonb_array_elements_text(t.metadata->'topics') as p
    left join remap r on r.old = p
  ) as topics_after
from thoughts t
where t.metadata ? 'topics'
  and exists (
    select 1 from jsonb_array_elements_text(t.metadata->'topics') as p
    join remap r on r.old = p
  );

-- ── Section 2: WRITE — uncomment after approval ───────────────────────────────
-- with remap(old, new) as (
--   values  /* same list as above */
-- )
-- update thoughts t
-- set metadata = jsonb_set(t.metadata, '{topics}', (
--       select jsonb_agg(distinct coalesce(r.new, p))
--       from jsonb_array_elements_text(t.metadata->'topics') as p
--       left join remap r on r.old = p
--     )),
--     updated_at = now()
-- where t.metadata ? 'topics'
--   and exists (
--     select 1 from jsonb_array_elements_text(t.metadata->'topics') as p
--     join remap r on r.old = p
--   );
