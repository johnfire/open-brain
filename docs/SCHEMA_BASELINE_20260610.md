# Live Schema Baseline — captured 2026-06-10 (pre-v2)

Project: `qaonmvqhlvrrvfkqcjbf`. Most schema was created via dashboard SQL before this
repo had migrations; this file records the live state that v2 migrations build on.

## Tables (public)

| Table                    | Rows | Notes                                                                                                                |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------- |
| thoughts                 | 252  | id, content, embedding vector(1536), metadata jsonb, created_at, updated_at, structural_sig jsonb                    |
| thought_edges            | 0    | id, source_id, target_id, label, weight float, insight text, created_by ('llm'), confirmed bool nullable, created_at |
| dream_runs               | 0    | id, started_at, completed_at, thoughts_processed, edges_proposed, edges_confirmed, status, error, notes              |
| topic_hints              | 52   | topic, description, category, active                                                                                 |
| people_aliases           | 5    | alias → canonical_name                                                                                               |
| people_exclusions        | 5    | names stripped from people arrays                                                                                    |
| grendel_thoughts         | 0    | legacy                                                                                                               |
| thoughts_backup_20260323 | 43   | pre-upgrade backup                                                                                                   |

## match_thoughts (pre-v2 definition)

```sql
CREATE OR REPLACE FUNCTION public.match_thoughts(query_embedding vector, match_threshold double precision DEFAULT 0.3, match_count integer DEFAULT 10, filter jsonb DEFAULT '{}'::jsonb, recency_weight double precision DEFAULT 0.15, max_age_days integer DEFAULT 365)
 RETURNS TABLE(id uuid, content text, metadata jsonb, similarity double precision, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    (1 - recency_weight) * (1 - (t.embedding <=> query_embedding))
    + recency_weight * GREATEST(0, 1.0 - (EXTRACT(EPOCH FROM (now() - t.created_at)) / (max_age_days * 86400.0)))
    as similarity,
    t.created_at
  from thoughts t
  where
    1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
    and COALESCE(t.metadata->>'status', 'active') != 'archived'
  order by
    (1 - recency_weight) * (1 - (t.embedding <=> query_embedding))
    + recency_weight * GREATEST(0, 1.0 - (EXTRACT(EPOCH FROM (now() - t.created_at)) / (max_age_days * 86400.0)))
    DESC
  limit match_count;
end;
$function$
```

## Edge functions (live)

- `open-brain-mcp` v11 — 12 MCP tools (source: this repo)
- `ingest-thought` v12 — webhook ingestion (source: this repo)
- `dream` v2 — edge proposer; source recovered into `supabase/functions/dream/` on 2026-06-10 (was deployed from a temp dir, not in repo)
- `backfill-embeddings` v3 — one-off utility, source not recovered (superseded)

## Usage stats at baseline

249→252 thoughts (21 Mar–10 Jun 2026), 128 tasks / 105 observations / 5 ideas / 3 person_notes / 2 references. thought_edges and dream_runs both empty — the dream job had never successfully produced an edge.
