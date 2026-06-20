# Open Brain — Le Chat MCP Connector Guide

_Last verified: 2026-06-20 (v2 / two-lane system). For what the system **is**, see
[OPEN_BRAIN_PLUS_PLUS.md](OPEN_BRAIN_PLUS_PLUS.md)._

## Overview

How to connect **Le Chat** (Mistral AI) to your **Open Brain** memory system over the Model
Context Protocol (MCP). Open Brain is a Supabase-hosted MCP server that stores and retrieves
semantic memories (thoughts) with graph-based connections between them — your external
hippocampus, because even AI assistants need help remembering things.

> **Security:** the access key is a secret. It is **not** stored in this document — keep it in
> your password manager or an env var (`OPEN_BRAIN_KEY`). See [Security](#security) at the end.

## Current Configuration

| Item | Value |
|------|-------|
| **MCP Server URL** | `https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp` |
| **Access Key** | held in your password manager / `OPEN_BRAIN_KEY` env var (not in this repo) |
| **Supabase Project** | `qaonmvqhlvrrvfkqcjbf` |
| **Project URL** | `https://qaonmvqhlvrrvfkqcjbf.supabase.co` |
| **Source Code** | `~/ppp2/open-brain/supabase/functions/open-brain-mcp/` |

## Authentication Methods

The server accepts the key three ways — because why settle for one way to say "please let me in":

1. **Custom Header** (original): `x-brain-key: <OPEN_BRAIN_KEY>`
2. **Query Parameter**: `?key=<OPEN_BRAIN_KEY>`
3. **Standard Bearer Token** (for Le Chat): `Authorization: Bearer <OPEN_BRAIN_KEY>`

The server checks all three in order:
```typescript
const provided = c.req.header("x-brain-key")
  || new URL(c.req.url).searchParams.get("key")
  || c.req.header("Authorization")?.replace("Bearer ", "");
```

## Setting Up the Le Chat Connector

### Prerequisites
- **Admin access** to your Le Chat organization (otherwise you're a guest at your own party)
- Account owner status (for Free, Pro, Student plans)

### Steps

1. **Open Le Chat** → **Connectors** page.
2. **`+ Add Connector`** → **Custom MCP Connector** tab.
3. Fill in:
   - **Connector name:** `open-brain`
   - **Server URL:** `https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp`
   - **Description:** `Christopher's Open Brain memory system`
4. **Connect.**
5. **Authentication:** Method = HTTP Bearer Token; Token = your `OPEN_BRAIN_KEY`.
6. **Save.**
7. **(Optional) Per-function permissions** — `My Connectors` → your connector → `Functions`:
   pre-authorize the read tools (below), keep the write tools on manual approval.

## Available MCP Tools (v2 — 17 total)

The authoritative list lives in [OPEN_BRAIN_PLUS_PLUS.md](OPEN_BRAIN_PLUS_PLUS.md#the-full-tool-set-17);
repeated here with the read/write split that matters for pre-authorization.

### Read functions — safe to pre-authorize

| Tool | Description |
|------|-------------|
| `search_thoughts` | Semantic search over thoughts — Google for your brain |
| `list_thoughts` | List recent thoughts with filters (type, topic, person, days, project, status) |
| `get_thought` | Full content + metadata for one thought (search results are truncated to 80 words) |
| `search_with_graph` | Vector search + graph expansion for cross-domain connections |
| `get_connected` | Traverse confirmed edges from a thought |
| `thought_stats` | Summary statistics of all thoughts |
| `retrieval_stats` | What's actually being read back (reads by tool, never-retrieved share, trend) |
| `list_topic_hints` | Active topic hints for guided extraction |
| `list_pending_edges` | Unreviewed edge proposals awaiting confirm/reject |
| `get_artifacts` | Pending work artifacts for a project |

### Write functions — keep on manual approval

| Tool | Description |
|------|-------------|
| `capture_thought` | Save a thought (auto-embedded); `lane='knowledge'` enforces ≤60-word atomic insights |
| `update_thought_status` | active → completed / superseded / archived (with reason + history) |
| `distill_session` | Store 1–3 atomic insights linked to a session summary |
| `add_topic_hint` | Add a topic-area hint for better extraction |
| `confirm_edge` | Confirm/reject a proposed insight edge |
| `push_artifact` | Push a spec/task document to Open Brain |
| `complete_artifact` | Mark an artifact complete and record results |

For **live stats** (thought counts, top topics, people) run `thought_stats` — numbers drift, so
this guide no longer hardcodes them.

## Deploying Changes

After modifying the MCP server code:
```bash
cd ~/ppp2/open-brain
supabase functions deploy open-brain-mcp --no-verify-jwt
```

## Testing the Server

Set the key in your shell first so it never lands in history files or this doc:
```bash
export OPEN_BRAIN_KEY="…"   # from your password manager
```

Verify reachability:
```bash
curl -I https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp
```

Bearer auth (Le Chat method):
```bash
curl -H "Authorization: Bearer $OPEN_BRAIN_KEY" \
  -H "Accept: application/json, text/event-stream" \
  https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp
```

MCP initialize handshake:
```bash
curl -X POST https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp \
  -H "Authorization: Bearer $OPEN_BRAIN_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
```
A successful response includes `"result"` with the server's capabilities.

## Troubleshooting

- **"Failed to verify token"** — Le Chat sent the auth in a format the server didn't recognise.
  Ensure the server reads the Bearer header (snippet above) and redeploy.
- **"MCP connection requires additional information or is invalid"** — wrong URL, server
  unreachable, bad credentials, or a failing handshake. Test the `initialize` call above; try the
  [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector).
- **401** — the provided key doesn't match the `MCP_ACCESS_KEY` env var on Supabase. Verify the
  key and the function's environment variables; Supabase restarts functions occasionally, so wait
  a minute and retry.

## Security

The access key grants full read/write to your memory. Treat it like a password:

1. **Never commit it.** Keep it in a password manager or an env var (`OPEN_BRAIN_KEY`); this repo
   stores only placeholders. (An earlier version of this file committed the literal key — it has
   been removed here and should be **rotated** on Supabase, since it still exists in git history.)
2. **Vet every MCP server** before connecting.
3. **Pre-authorize only read tools**; keep writes on manual approval until you trust the flow.
4. **Guard against prompt injection** — review tool inputs/outputs for anything unexpected.

## Related Files

- **MCP server:** `~/ppp2/open-brain/supabase/functions/open-brain-mcp/index.ts`
- **Client MCP config:** `~/.claude/.mcp.json` (or the Le Chat connector settings)
- **System overview:** [OPEN_BRAIN_PLUS_PLUS.md](OPEN_BRAIN_PLUS_PLUS.md)
