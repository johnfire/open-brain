# Open Brain v2 — Knowledge-Graph Journal

**Implementation Specification for Claude Code**

Author: Christopher Rehm & Claude · Date: 11 June 2026 · Status: Approved for implementation
Target system: Open Brain MCP (Supabase Edge Function `open-brain-mcp`, Postgres + pgvector)

---

## 1. Purpose and Success Criteria

### 1.1 The decision

Three months of usage data (249 thoughts, 21 Mar – 10 Jun 2026, ~3/day) show Open Brain functioning as a **session-continuity journal**: 128 tasks + 105 observations, only 5 ideas, 3 person notes, 2 references. The original "second brain" ambition — a graph that surfaces non-obvious connections — has produced no visible value because (a) the graph layer is unused and (b) the raw material is wrong: 300–500-word multi-topic session summaries embed as semantic mush and make poor graph nodes.

**The chosen direction is a hybrid: a knowledge-graph journal.** Keep the journal (it demonstrably works for cross-session state transfer) and make the graph actually function by feeding it the right material. This is a two-lane architecture (Section 2).

### 1.2 Primary success criterion

> **The system surfaces connections Christopher did not see himself.**

Operationalized: **at least one confirmed, genuinely novel insight edge per month** — a cross-domain connection (art ↔ engineering ↔ business ↔ geopolitics) that was not already explicit in his own thinking. Measured via the edge-review ritual (Section 6.2).

### 1.3 Secondary success criteria

1. Sessions start with **correct** context: no stale tasks presented as live. Target: 100% of retrieved tasks have accurate status.
2. Session-start retrieval costs **< 1,500 tokens** (currently 3–5k). Token exhaustion paused work on 10 June; this is not theoretical.
3. Within 60 days, read-side instrumentation answers: which thoughts are retrieved, which never are, and whether search (vs. session-start dumps) changes decisions.

### 1.4 Failure signs

- Edge proposals are consistently trivial ("both mention LeGuilde") → graph material still wrong, revisit distillation prompt.
- Zero confirmed edges after 2 months of weekly reviews → the corpus may lack diversity for a single-user graph; trigger the kill-decision in Section 8.
- Task statuses drift stale again → the session-close protocol is not being followed; protocol problem, not code problem.

### 1.5 Honest cost statement

The graph only pays off with **human-in-the-loop curation**: ~15 minutes/week reviewing proposed edges, plus capturing 1–3 atomic insights at session close. If that investment will not happen, build only Lane 1 items (Sections 3.1–3.4) and skip Lane 2. There is no automation that substitutes for edge confirmation; unconfirmed machine-proposed edges are noise.

---

## 2. Architecture: Two Lanes

```
                       ┌────────────────────────────────────┐
                       │            thoughts table          │
                       │                                    │
  session close ──────►│  LANE 1: JOURNAL                   │
  (verbose summary)    │  lane='journal'                    │
                       │  types: task, observation, artifact│
                       │  lifecycle-managed, compacted,     │
                       │  truncated on retrieval            │
                       │                                    │
  session close ──────►│  LANE 2: KNOWLEDGE                 │
  (1–3 atomic insights)│  lane='knowledge'                  │
                       │  types: idea, insight, reference,  │
                       │         person_note                │
                       │  atomic (≤ 60 words), single-topic,│
                       │  graph nodes — dream job runs HERE │
                       └────────────────────────────────────┘
                                       │
                              insight_edges table
                              (proposed by dream job,
                               confirmed/rejected weekly)
```

**Lane 1 (Journal)** answers: *what was the state of project X, what was decided, what is open?* Optimized for correctness and token economy. Verbose is fine; retrieval is truncated.

**Lane 2 (Knowledge)** answers: *what do I believe, what have I learned, how do things connect?* Nodes must be atomic — one claim, one topic, ≤ 60 words — because embedding quality and edge quality both degrade with multi-topic content. The dream job (edge proposer) operates **only** on Lane 2.

A session summary and its distilled insights are linked via `metadata.source_session_id` so the graph can always trace an insight back to its journal context.

---

## 3. Work Items — Lane 1 (Journal correctness and economy)

Priority order. Items 3.1–3.4 are independent and individually deployable. **Anti-fragility requirement for ALL items: every new code path must fail gracefully and never break an existing tool. Instrumentation failure must not break search. A malformed status update must return a clear error, not a 500. Wrap each handler's new logic in its own try/catch with structured JSON logging.**

### 3.1 Task lifecycle — `update_thought_status` tool

**Problem:** 128 tasks captured, 0 ever marked completed. Retrieval asserts stale action items as live. A memory that is confidently wrong is worse than no memory.

**Schema:** none required if `metadata.status` already exists (it does — capture sets `status: "active"`). Add a partial index for filter performance:

```sql
create index if not exists idx_thoughts_status
  on thoughts ((metadata->>'status'));
```

**New MCP tool:**

```
update_thought_status
  id:        string (uuid, required)
  status:    enum required — 'active' | 'completed' | 'superseded' | 'archived'
  reason:    string optional — recorded into metadata.status_history[]
```

Behavior: single `UPDATE thoughts SET metadata = jsonb_set(...)`, append `{status, reason, ts}` to `metadata.status_history`. Return the updated row's id, old status, new status. Reject unknown ids and unknown status values with explicit error messages (400-style MCP error, not a crash).

**Search ranking change:** in `match_thoughts`, demote non-active journal thoughts rather than hiding them (history must stay findable):

```sql
-- inside match_thoughts ordering
order by
  (1 - (embedding <=> query_embedding))
  * case when metadata->>'status' in ('completed','superseded','archived')
         then 0.8 else 1.0 end desc
```

**Protocol change (no code):** session-close instruction becomes: *before capturing the new summary, list open tasks for the project (`list_thoughts project=X status=active type=task`) and call `update_thought_status` on anything completed or superseded by this session.* This goes into Christopher's userPreferences / CLAUDE.md Open Brain block.

### 3.2 Retrieval payload truncation + `get_thought`

**Problem:** session-start searches return 10 × 300–500-word thoughts ≈ 3–5k tokens before work begins.

**Change:** `search_thoughts`, `list_thoughts`, and `search_with_graph` return for each hit: `id`, first **80 words** of content + `…`, `type`, `status`, `project`, `topics`, `created_at`, `similarity`. Lane 2 thoughts are ≤ 60 words by definition, so they always return in full.

**New MCP tool:**

```
get_thought
  id: string (uuid, required)
```

Returns full content + full metadata for one thought. The truncated search result text must state: "(truncated — get_thought for full text)" once per response, not per item.

**Compatibility note:** verify nothing downstream parses full content out of search results (nothing known does).

### 3.3 Metadata signal quality

Two changes to the capture-time extraction prompt in the Edge Function:

1. **Self-tag filter:** never emit "Christopher Rehm" (or "Chris") in `people` — he is the implicit subject of everything; 141/249 thoughts carry the tag, information content zero. Keep all *other* people.
2. **Controlled topic vocabulary:** extraction prompt must first try to match against the active topic hints (`list_topic_hints`) and only invent a new topic when nothing fits. Seed the hints table with a consolidation pass, e.g.: `art-business` (absorbs art marketing / art venues / gallery outreach), `leguilde`, `consultancy`, `open-brain`, `claude-code`, `geopolitics`, `flashkarte`, `philosophy`, `gz-application` (absorbs Gründungszuschuss / ATS optimization where applicable). Christopher approves the final hint list before seeding.

**One-time data migration (separate reviewable script, idempotent):** strip the self-tag from existing rows; optionally remap fragmented topics to the new vocabulary. Must be runnable in dry-run mode that prints the diff before writing.

### 3.4 Read-side instrumentation

**Problem:** write-side metrics exist; retrieval value is unmeasured. All future investment decisions should be gated on this data.

**Schema:**

```sql
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
```

**Edge Function:** after each successful read, increment `retrieval_count` / set `last_retrieved_at` on returned rows and insert one `retrieval_log` row. **This must be fire-and-forget: any failure here is logged and swallowed; the search response is never blocked or degraded by instrumentation.**

**New MCP tool (read-only):**

```
retrieval_stats
  days: number optional (default 30)
```

Returns: total reads by tool, top-10 most-retrieved thoughts, count and percentage of never-retrieved thoughts, reads-per-day trend. This is what answers Section 1.3 #3 after ~60 days.

---

## 4. Work Items — Lane 2 (Knowledge graph that actually surfaces connections)

### 4.1 Lane column and atomicity contract

**Schema:**

```sql
alter table thoughts
  add column if not exists lane text not null default 'journal'
  check (lane in ('journal','knowledge'));

create index if not exists idx_thoughts_lane on thoughts (lane);
```

Backfill: existing `idea`, `reference`, `person_note` rows → `lane='knowledge'`; everything else stays `journal`.

**Capture contract:** `capture_thought` gains optional `lane` parameter (default `journal`). When `lane='knowledge'`, the Edge Function **enforces atomicity**: if content > ~70 words or the extraction LLM judges it multi-topic, reject with a message instructing the caller to split it. Hard limits beat soft conventions.

### 4.2 Distillation at session close

**New MCP tool:**

```
distill_session
  session_summary_id: string (uuid of the just-captured journal thought)
  insights: array of { content: string (≤60 words), topics?: string[] }   # 1–3 items
```

Stores each insight as `lane='knowledge'`, `type='insight'`, `metadata.source_session_id = session_summary_id`. (Implementable as a thin wrapper over capture; the wrapper exists so the protocol step is one explicit call and the linkage is never forgotten.)

**Protocol change (no code):** session close becomes a fixed three-step ritual: (1) update statuses (3.1), (2) capture journal summary, (3) distill 1–3 atomic insights — *what was learned*, not *what was done*. Example of the distinction: journal = "fixed gallery URL double-segmentation via route restructuring"; insight = "Next.js basePath plus a same-named route directory silently double-segments URLs — keep basePath out of the app directory structure."

### 4.3 Dream job scoped to Lane 2, with quality bar

The edge-proposing job changes in three ways:

1. **Scope:** candidate nodes are `lane='knowledge'` only. Journal summaries are excluded — this is the single biggest edge-quality fix.
2. **Cross-domain bias:** score candidate pairs higher when their primary topics differ (the stated goal is connections *across* art / engineering / business / geopolitics, not within-project adjacency). Pairs sharing a project AND a topic are deprioritized.
3. **Proposal justification:** every proposed edge stores a one-sentence machine rationale (`edge.rationale`). Edges without a falsifiable rationale ("both relate to art") should not be proposed; the proposer prompt must demand a *because*-clause stating the non-obvious link.

Cap proposals at **10 per week** so the review ritual stays at ~15 minutes. Quality over volume.

### 4.4 Edge review tooling

`confirm_edge` exists. Add:

```
list_pending_edges
  limit: number optional (default 10)
```

Returns pending proposals with both node contents (full — they are atomic), rationale, and proposal date, ordered newest first. Confirmed edges feed `search_with_graph` / `get_connected`; rejected edges are kept with status `rejected` so the dream job never re-proposes the same pair (enforce with a uniqueness check on the node-pair).

### 4.5 Monthly compaction (build last, optional)

After items 3.1–3.4 and 4.1–4.4 are live for a month, evaluate whether verbose journal entries older than ~90 days with `retrieval_count = 0` should be distilled into short reference thoughts and archived. **Do not build speculatively** — instrumentation (3.4) decides whether this is needed.

---

## 5. Implementation Notes for Claude Code

1. **Single source of truth:** all changes go through the existing repo flow — migrations in `supabase/migrations/`, Edge Function in `supabase/functions/open-brain-mcp/index.ts`, deploy via `supabase functions deploy open-brain-mcp --no-verify-jwt`.
2. **Migrations are idempotent** (`if not exists` everywhere) and each work item is a separate migration file, separately revertible.
3. **Anti-fragility (restating because it is a hard requirement):** every handler isolates its failure domain. New columns must be nullable-or-defaulted so old code paths keep working mid-deploy. Instrumentation writes are fire-and-forget. The MCP tool list must remain valid even if one tool's handler throws — per-tool try/catch, structured JSON error logging, no top-level crashes.
4. **Embedding dimensions** stay at 1536; no model changes in this work.
5. **Testing:** for each new tool, a happy-path call + at least one malformed-input call against a local `supabase start` instance before deploy. For `match_thoughts` ranking change, verify a completed task ranks below an active one of equal similarity.
6. **Suggested build order / sessions:** Session A = 3.1 + 3.2 (correctness + tokens, biggest immediate payoff). Session B = 3.3 + 3.4 (signal + instrumentation, includes the one-time migration with dry run). Session C = 4.1 + 4.2 (lanes + distillation). Session D = 4.3 + 4.4 (dream job rescope + review tooling). Estimated total: 2–4 focused sessions.

---

## 6. Protocols (human side — no code, but the system fails without them)

### 6.1 Session close (every working session)

1. List open tasks for the project; `update_thought_status` anything done or superseded.
2. Capture the journal summary (verbose is fine; it gets truncated on retrieval).
3. `distill_session` with 1–3 atomic insights — *learned*, not *done*.

### 6.2 Weekly edge review (~15 min, suggest Friday)

1. `list_pending_edges` — review up to 10 proposals.
2. Confirm the genuinely interesting; reject the trivial. Honesty matters here: confirming weak edges to feel productive corrupts the graph.
3. Log one line: how many confirmed, and whether anything was *actually* novel. This is the data for the Section 1.2 metric.

### 6.3 Monthly check (~10 min)

1. `retrieval_stats` — is anything being read? What is dead weight?
2. Count of confirmed-novel edges this month against the ≥1/month target.
3. After month 2: execute Section 8 decision if the graph is failing.

---

## 7. Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | `update_thought_status` changes status, records history, rejects bad input | tool calls + table inspection |
| 2 | Completed/superseded tasks rank below equal-similarity active ones | controlled search test |
| 3 | Search/list responses ≤ 80 words per journal hit; `get_thought` returns full text | tool calls |
| 4 | Session-start context pull measured < 1,500 tokens | live session check |
| 5 | "Christopher Rehm" never appears in `people` on new captures | capture test |
| 6 | New captures use the controlled topic vocabulary when applicable | capture tests across 3 projects |
| 7 | Reads increment `retrieval_count` and log; an injected instrumentation failure does NOT break search | fault-injection test |
| 8 | `lane='knowledge'` capture rejects > 70-word or multi-topic content with a helpful message | capture tests |
| 9 | Dream job proposes only knowledge-lane pairs, ≤ 10/week, each with a because-rationale | inspect proposals table |
| 10 | Rejected edge pairs are never re-proposed | re-run dream job after rejection |
| 11 | All pre-existing tools behave identically for untouched functionality | regression pass of original tool calls |

---

## 8. Kill Criteria for the Graph Layer

If after **two full months** of followed protocol (≥ 6 weekly reviews, ≥ 40 knowledge-lane thoughts captured) there are **zero confirmed genuinely-novel edges**, the honest conclusion is that a single-user corpus of this shape does not support cross-domain edge discovery. In that case: stop the dream job, drop the weekly ritual, keep Lane 2 capture and plain vector search (atomic insights are valuable for retrieval regardless), and keep all Lane 1 improvements, which stand on their own merits. No zombie features.

---

*End of specification.*
