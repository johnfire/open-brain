-- v2 Session B (spec 3.4): read-side instrumentation.
-- Write-side metrics exist; retrieval value is unmeasured. Future investment
-- decisions are gated on this data.

alter table thoughts
  add column if not exists retrieval_count int not null default 0,
  add column if not exists last_retrieved_at timestamptz;

create table if not exists retrieval_log (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  tool        text not null,            -- search_thoughts | list_thoughts | search_with_graph | get_thought
  query       text,                     -- null for list/get
  result_ids  uuid[] not null,
  client_hint text                      -- optional, from request header if present
);

create index if not exists idx_retrieval_log_ts on retrieval_log (ts);

-- Single round-trip counter bump for a batch of returned thoughts.
create or replace function public.increment_retrieval(ids uuid[])
returns void
language sql
as $$
  update thoughts
  set retrieval_count = retrieval_count + 1,
      last_retrieved_at = now()
  where id = any(ids);
$$;

-- Grants + RLS following 20260514102720_add_explicit_grants.sql
grant select, insert on public.retrieval_log to service_role;
alter table public.retrieval_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'retrieval_log' and policyname = 'Service role full access'
  ) then
    create policy "Service role full access" on public.retrieval_log
      for all to service_role using (true) with check (true);
  end if;
end $$;
