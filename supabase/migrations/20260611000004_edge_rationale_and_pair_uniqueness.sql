-- v2 Session D (spec 4.3, 4.4): edge quality.
-- rationale: machine because-clause stored with every proposal.
-- pair uniqueness: a node pair is proposed at most once, ever — rejected pairs
-- stay in the table (confirmed=false) and can never be re-proposed.

alter table thought_edges
  add column if not exists rationale text;

create unique index if not exists uq_thought_edges_pair
  on thought_edges (least(source_id, target_id), greatest(source_id, target_id));
