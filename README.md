# Open Brain

A Supabase-hosted **MCP memory system** — a two-lane knowledge-graph journal. AI clients
(Claude Code, Le Chat, claude.ai) capture and retrieve semantic "thoughts" with graph-based
connections between them. The deployed code is exactly what's committed here.

- **Live:** Supabase project `qaonmvqhlvrrvfkqcjbf` — edge functions `open-brain-mcp`,
  `ingest-thought`, `dream`.
- **Deploy:** `supabase functions deploy <name> --no-verify-jwt`
- **Protocols** (session-close ritual, weekly edge review) live in the Open Brain block of
  `~/.claude/CLAUDE.md`.

## Docs

Read the one relevant to your task.

| Doc | Read when… |
| --- | --- |
| [docs/OPEN_BRAIN_PLUS_PLUS.md](docs/OPEN_BRAIN_PLUS_PLUS.md) | **Canonical overview** — what the v2 system is, the two lanes, the 17 tools, where everything lives. Keep current; update in place. |
| [docs/LECHAT_CONNECTOR.md](docs/LECHAT_CONNECTOR.md) | Connecting an external MCP client (Le Chat / Mistral) — URL, auth, setup, the read/write tool split. |
| [docs/older-docs/](docs/older-docs/) | Archive — the v2 implementation spec (shipped), the pre-v2 schema snapshot, the executed topic-consolidation proposal. Historical reference only. |

## Code layout

```
supabase/functions/   open-brain-mcp · ingest-thought · dream   (edge functions)
supabase/migrations/  schema (source of truth — the live DB is built from these)
scripts/              one-off SQL migrations (topic remap, self-tag strip)
docs/                 the docs indexed above
```
