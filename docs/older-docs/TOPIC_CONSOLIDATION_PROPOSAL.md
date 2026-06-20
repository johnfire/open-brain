# Topic Vocabulary Consolidation — APPROVED & EXECUTED 2026-06-11

Approved by Christopher 2026-06-11 and executed the same day: 50 old hints
deactivated, the 14 hints below seeded as the active vocabulary, and the remap
applied to 155 existing thoughts (0 old tags remain). `client acquisition` /
`networking` were left untouched pending his call (see footnote).

Original proposal below, built from the actual topic distribution of all 252
thoughts (2026-06-10).

## Current state

52 active topic hints; extraction has produced ~200 distinct topic strings with heavy
fragmentation, e.g. `Open Brain`/`open-brain`/`MCP tools`/`MCP server`,
`ATS`/`ATS optimization`/`CV optimization`/`CV generation`/`resume writing`,
`art marketing`/`gallery outreach`/`art venues`.

## Proposed controlled vocabulary (14 hints)

| Hint               | Absorbs (top fragments)                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `art-business`     | art marketing (14), gallery outreach (11), art venues (9), client acquisition*, networking*                                                          |
| `art-practice`     | watercolor painting (4), art (5)                                                                                                                     |
| `leguilde`         | art-platform (9)                                                                                                                                     |
| `consultancy`      | rehm-consulting (5), consultancy (5), consultancy launch (4), business strategy (7), self-employment (6)                                             |
| `gz-application`   | Gründungszuschuss (10), ATS optimization (9), ATS (5), CV optimization (5), CV generation (4), resume writing (4), career development (8), ALG I (4) |
| `open-brain`       | Open Brain (18), open-brain (4), MCP server (5), MCP tools (4), cognitive architecture (5)                                                           |
| `claude-code`      | Claude Code (10), Claude workflow (5), AI agents (9), automation (4)                                                                                 |
| `engineering`      | web development (8), CI/CD (8), software development (5), testing (6), architecture (5), Python (5), React (4), Kotlin (3), Supabase (4), Ubuntu (4) |
| `geopolitics`      | geopolitics (12), international relations (4)                                                                                                        |
| `geopolitical-sim` | geopolitical simulation (6)                                                                                                                          |
| `philosophy`       | philosophy (9), AI alignment (4), AGI (4), decision making (3)                                                                                       |
| `flashkarte`       | (new project, no fragments yet)                                                                                                                      |
| `theo-van-gogh`    | Theo van Gogh (5)                                                                                                                                    |
| `grendel`          | Grendel (4), Grendel project (4)                                                                                                                     |

\* client acquisition / networking could also belong to `consultancy` — flag for your call.

## What happens on approval

1. Deactivate the 52 current hints (`active=false`, kept for history).
2. Insert the approved hints with descriptions.
3. Optional remap of existing rows' `metadata.topics` to the new vocabulary
   (dry-run SQL in `scripts/migrate_topic_remap.sql` prints the full diff first).

## What's already live without approval (per spec)

- Extraction prompts now _prefer_ existing hints over inventing topics (both
  capture paths), and emit 1-5 tags instead of the old forced 5-7.
- The self-tag ("Christopher Rehm" in `people`) is filtered in code + prompt,
  and was stripped from the 145 existing rows that carried it.
