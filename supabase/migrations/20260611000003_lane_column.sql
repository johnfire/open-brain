-- v2 Session C (spec 4.1): two-lane architecture.
-- Lane 1 'journal' = session-continuity state (verbose, lifecycle-managed).
-- Lane 2 'knowledge' = atomic single-topic insights — the only graph material.

alter table thoughts
  add column if not exists lane text not null default 'journal'
  check (lane in ('journal','knowledge'));

create index if not exists idx_thoughts_lane on thoughts (lane);

-- Backfill: existing knowledge-shaped types move to the knowledge lane.
update thoughts
set lane = 'knowledge'
where metadata->>'type' in ('idea','reference','person_note')
  and lane = 'journal';
