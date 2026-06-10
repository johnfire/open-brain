-- v2 Session A (spec 3.1): task lifecycle support
-- 1) Partial-expression index for status filtering
-- 2) match_thoughts: demote completed/superseded/archived instead of hiding archived
--    (history must stay findable; ranking change per spec section 3.1)

create index if not exists idx_thoughts_status
  on thoughts ((metadata->>'status'));

create or replace function public.match_thoughts(
  query_embedding vector,
  match_threshold double precision default 0.3,
  match_count integer default 10,
  filter jsonb default '{}'::jsonb,
  recency_weight double precision default 0.15,
  max_age_days integer default 365
)
returns table(id uuid, content text, metadata jsonb, similarity double precision, created_at timestamp with time zone)
language plpgsql
as $function$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    (
      (1 - recency_weight) * (1 - (t.embedding <=> query_embedding))
      + recency_weight * GREATEST(0, 1.0 - (EXTRACT(EPOCH FROM (now() - t.created_at)) / (max_age_days * 86400.0)))
    )
    * case when COALESCE(t.metadata->>'status', 'active') in ('completed','superseded','archived')
           then 0.8 else 1.0 end
    as similarity,
    t.created_at
  from thoughts t
  where
    1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by
    (
      (1 - recency_weight) * (1 - (t.embedding <=> query_embedding))
      + recency_weight * GREATEST(0, 1.0 - (EXTRACT(EPOCH FROM (now() - t.created_at)) / (max_age_days * 86400.0)))
    )
    * case when COALESCE(t.metadata->>'status', 'active') in ('completed','superseded','archived')
           then 0.8 else 1.0 end
    DESC
  limit match_count;
end;
$function$;
