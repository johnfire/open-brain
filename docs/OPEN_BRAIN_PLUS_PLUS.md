# Open Brain ++ — The v2 System Explained

_Written 11 June 2026, after the v2 implementation (Sessions A–D of [open-brain-v2-spec.md](open-brain-v2-spec.md)). This is the plain-language companion: what the system is now, why it changed, and how to live with it._

---

## What Open Brain was, and what it is now

The original Open Brain (March 2026) was a single bucket: every thought — session summaries, tasks, ideas, observations — went into one `thoughts` table with an embedding, and semantic search pulled things back out. After three months and ~250 thoughts the honest assessment was: it works well as a **structured project journal with semantic search and cross-session state transfer**, but the "second brain" features (the insight graph, the dream job) sat unused, stale completed tasks polluted search results, and nobody knew whether anything was ever actually _read_ back.

v2 keeps what worked and fixes the three real problems:

1. **Stale memories outranked fresh ones** → lifecycle statuses now demote them.
2. **Reads were invisible** → every retrieval is now instrumented.
3. **The graph had nothing worth connecting** → a dedicated knowledge lane now feeds it atomic insights, and the dream job only eats from that lane.

The result is a **two-lane knowledge-graph journal**.

## The two lanes

Every thought now has a `lane` column:

|                     | `journal` (default)                                                                             | `knowledge`                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **What goes here**  | Session summaries, tasks, observations, artifacts — the working state of your life and projects | Atomic insights: one claim, one topic, ≤60 words                 |
| **Lifecycle**       | Managed: active → completed / superseded / archived                                             | Mostly permanent — insights don't expire the way tasks do        |
| **Graph material?** | **No.** The dream job never looks at it                                                         | **Yes.** This is the _only_ thing the dream job reads            |
| **Verbosity**       | As long as it needs to be                                                                       | Hard-capped; the server rejects >60-word or multi-topic captures |

Why the split: connecting two 400-word session summaries produces mush. Connecting "X works because Y" to "Z fails for the same structural reason" produces an insight. Atomicity is what makes edges meaningful, so atomicity is enforced at the API — `capture_thought(lane='knowledge')` rejects anything too long or judged multi-topic, with instructions to split it.

## The session-close ritual (the heart of the system)

Three steps, in order, at the end of every working session:

1. **Update statuses.** Every open task that got finished or overtaken this session gets `update_thought_status(id, 'completed'|'superseded', reason)`. This is step one because _a memory that is confidently wrong is worse than no memory_ — and because completed/superseded/archived thoughts are now **demoted (×0.8), not hidden** in search ranking. History stays findable; it just stops outranking the present.

2. **Capture the journal summary.** One `capture_thought(lane='journal')` with decisions, blockers, progress, next steps — same as v1.

3. **Distill.** `distill_session(summary_id, insights)` — 1 to 3 atomic insights answering "what did we _learn_?", not "what did we _do_?". Each lands on the knowledge lane, linked back to the source session (`source_session_id`), so every graph node is traceable to the session that produced it. If nothing was learned, skip it; padding corrupts the graph.

This ritual is now encoded in `~/.claude/CLAUDE.md`, so every Claude Code session follows it automatically.

## The dream job, rescoped

The nightly `dream` function used to compare everything to everything. Now it:

- reads **knowledge-lane thoughts only**;
- prefers **cross-domain pairs** (different projects/topics) — that's where non-obvious insight lives;
- must produce a **falsifiable rationale** containing the word "because" for every proposed edge — no rationale, no edge;
- proposes **at most 10 edges per week** (a budget, so review stays a 5-minute ritual, not a chore);
- **never re-proposes a rejected pair** — a unique index on the node pair makes this structural, not behavioral.

## The weekly edge review

Once a week (weekend works): `list_pending_edges` shows every unreviewed proposal with both thoughts in full, the machine's because-rationale, and the proposal date. For each: `confirm_edge(id, true)` if it's genuinely interesting, `confirm_edge(id, false)` if it's trivial or wrong.

**Reject honestly.** Confirming weak edges to feel productive corrupts the graph, and rejections are cheap — that pair can never come back. Confirmed edges get traversal priority in `get_connected` and `search_with_graph`.

## Read instrumentation — the system now measures itself

Every retrieval (search, list, get, graph search) increments `retrieval_count` on the thoughts returned and logs a row in `retrieval_log` — fire-and-forget, so a logging failure can never break a search.

`retrieval_stats` turns this into the report that answers the question v1 couldn't: **is this memory worth anything?** Reads by tool, most-retrieved thoughts, never-retrieved share, reads-per-day trend. At the 6-month review, "X% of thoughts were never read" is data, not a guess.

## Smaller quality fixes that shipped alongside

- **80-word truncation** in search/list results with a `get_thought` pointer — long thoughts no longer flood a session's context window.
- **Self-tag filter**: "Christopher Rehm" was tagged as a _person_ on 141 of 249 thoughts — zero information, since you are the implicit author of all of them. Stripped from the 145 existing rows and hard-filtered at ingestion (all name variants).
- **Controlled topic vocabulary**: extraction now sees the active `topic_hints` and is told to reuse them before inventing new tags. (The one-time remap of the existing 60+ scattershot tags into ~14 canonical ones is **prepared but gated** — see below.)
- **`status_history`** on every status change: who/when/why, kept in metadata.

## The full tool set (17)

**Capture & lifecycle:** `capture_thought` (now with `lane`), `update_thought_status`, `distill_session`
**Retrieval:** `search_thoughts`, `list_thoughts`, `get_thought`, `search_with_graph`, `get_connected`
**Graph curation:** `list_pending_edges`, `confirm_edge`
**Health:** `thought_stats`, `retrieval_stats`
**Topics:** `add_topic_hint`, `list_topic_hints`
**Artifact handoff (claude.ai → Claude Code):** `push_artifact`, `get_artifacts`, `complete_artifact`

## Topic consolidation — approved & executed 2026-06-11

Per the spec, vocabulary changes needed Christopher's sign-off; he approved on 11 June 2026 and both steps ran the same day:

1. **Topic consolidation** — the 14-hint controlled vocabulary from [TOPIC_CONSOLIDATION_PROPOSAL.md](TOPIC_CONSOLIDATION_PROPOSAL.md) is now seeded in `topic_hints`; the 50 old hints were deactivated (kept for history).
2. **Topic remap** — [scripts/migrate_topic_remap.sql](../scripts/migrate_topic_remap.sql) remapped 155 existing thoughts onto the new vocabulary; zero old tags remain.

Still open (your call, flagged in the proposal): whether `client acquisition` / `networking` tags should fold into `art-business` or `consultancy` — they were left untouched.

## Where everything lives

- **Repo (single source of truth):** `~/ppp2/open-brain` — all three edge functions (`open-brain-mcp`, `ingest-thought`, `dream`), migrations, scripts, docs. The deployed code is exactly what's committed.
- **Live:** Supabase project `qaonmvqhlvrrvfkqcjbf` — `open-brain-mcp` v12, `ingest-thought` v13, `dream` v3, all migrations applied.
- **Spec:** [open-brain-v2-spec.md](open-brain-v2-spec.md). **Pre-v2 schema snapshot:** [SCHEMA_BASELINE_20260610.md](SCHEMA_BASELINE_20260610.md).
- **Protocols:** the Open Brain block in `~/.claude/CLAUDE.md`.
