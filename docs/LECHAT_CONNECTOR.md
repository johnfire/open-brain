# Open Brain - Le Chat MCP Connector Guide

## Overview

This document describes how to connect **Le Chat** (Mistral AI) to your **Open Brain** memory system via the Model Context Protocol (MCP).

Open Brain is a Supabase-hosted MCP server that stores and retrieves semantic memories (thoughts) with graph-based connections between ideas. Think of it as your external hippocampus — because even AI assistants need a little help remembering things sometimes.

## Current Configuration

| Item | Value |
|------|-------|
| **MCP Server URL** | `https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp` |
| **Access Key** | `bf402ca9240a2d5481bf7314033b3d02cbb3a691a6efc871ccb72d8cf022227c` |
| **Supabase Project** | `qaonmvqhlvrrvfkqcjbf` |
| **Project URL** | `https://qaonmvqhlvrrvfkqcjbf.supabase.co` |
| **Source Code** | `/home/christopher/programming/open-brain/supabase/functions/open-brain-mcp/` |

## Authentication Methods

The Open Brain MCP server supports three authentication methods — because why settle for one way to say "please let me in"?

1. **Custom Header** (original): `x-brain-key: <access_key>`
2. **Query Parameter**: `?key=<access_key>`
3. **Standard Bearer Token** (for Le Chat): `Authorization: Bearer <access_key>`

The server code in `index.ts` checks for all three in order:
```typescript
const provided = c.req.header("x-brain-key")
  || new URL(c.req.url).searchParams.get("key")
  || c.req.header("Authorization")?.replace("Bearer ", "");
```

*Pro tip: If the server rejects your auth, it's not you — it's probably the header format.*

## Setting Up Le Chat Connector

### Prerequisites
- **Admin access** to your Le Chat organization (if you don't have this, you're basically a guest at your own party)
- Account owner status (for Free, Pro, Student plans)

### Steps

1. **Open Le Chat** and navigate to the **Connectors** page

2. **Click `+ Add Connector`** and switch to the **Custom MCP Connector** tab

3. **Fill in the connector details:**
   - **Connector name:** `open-brain` (or `open-brain-memory` if you prefer verbose naming)
   - **Server URL:** `https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp`
   - **Description:** `Christopher's Open Brain memory system`

4. **Click `Connect`** (the moment of truth)

5. **Configure Authentication:**
   - **Method:** HTTP Bearer Token
   - **Token:** `bf402ca9240a2d5481bf7314033b3d02cbb3a691a6efc871ccb72d8cf022227c`

6. **Save** the connector (deep breath, you're almost there)

7. **(Optional) Set per-function permissions:**
   - Go to `Connectors` → `My Connectors`
   - Click your Open Brain connector
   - Go to `Functions` tab
   - Toggle `Always Allow` for **read functions** (the safe ones):
     - `search_thoughts`
     - `list_thoughts`
     - `thought_stats`
     - `list_topic_hints`
     - `get_artifacts`
     - `get_connected`
   - Keep **write functions** on manual approval (trust but verify):
     - `capture_thought`
     - `add_topic_hint`
     - `push_artifact`
     - `complete_artifact`
     - `confirm_edge`

## Available MCP Tools

### Read Functions (Safe to Pre-Authorize)

These won't break anything. Probably.

| Tool | Description |
|------|-------------|
| `search_thoughts` | Search captured thoughts by semantic meaning — like Google for your brain |
| `list_thoughts` | List recent thoughts with optional filters (type, topic, person, days, project, status) |
| `thought_stats` | Get summary statistics of all thoughts — for when you need to quantify your existential angst |
| `list_topic_hints` | List all active topic hints for guided extraction |
| `get_artifacts` | Retrieve pending work artifacts for a project |
| `get_connected` | Traverse graph to find connected thoughts — because everything is connected, apparently |

### Write Functions (Keep on Manual Approval)

These can change things. Be careful.

| Tool | Description |
|------|-------------|
| `capture_thought` | Save a new thought with auto-generated embedding and metadata — your digital journal |
| `add_topic_hint` | Add a new topic area hint for better recognition — teach your brain to recognize new things |
| `push_artifact` | Push a structured spec/task document to Open Brain |
| `complete_artifact` | Mark an artifact as complete and record results — the satisfaction of checking boxes, digitally |
| `confirm_edge` | Confirm or reject insight edges between thoughts — playing god with your own knowledge graph |

### Advanced Functions

For when you're feeling adventurous.

| Tool | Description |
|------|-------------|
| `search_with_graph` | Vector search + automatic graph expansion for cross-domain connections — because linear thinking is so 2023 |

## Current Statistics

As of May 2, 2026:
- **Total thoughts:** 156 (and counting — your brain is busy)
- **Date range:** March 21, 2026 → May 2, 2026
- **Types:** 72 tasks, 71 observations, 5 ideas, 2 artifacts, 2 person_notes, 1 reference, 1 personal_context, 1 analytical_note, 1 meta_relationship

**Top topics:** Open Brain (13), gallery outreach (11), Gründungszuschuss (10), art marketing (9), art venues (9), Claude Code (8), AI (7), testing (6), networking (6), philosophy (6)

**Most mentioned people:** Christopher Rehm (98 — narcissism is a feature, not a bug), Claude (5), Allan S. Rehm (4), Netanyahu (4), Trump (4)

## Deploying Changes

After modifying the MCP server code:

```bash
cd /home/christopher/programming/open-brain
supabase functions deploy open-brain-mcp
```

*If this fails, you probably forgot to save a file. We've all been there.*

## Testing the Server

### Verify reachability:
```bash
curl -I https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp
```

### Test with Bearer auth (Le Chat method):
```bash
curl -H "Authorization: Bearer bf402ca9240a2d5481bf7314033b3d02cbb3a691a6efc871ccb72d8cf022227c" \
  -H "Accept: application/json, text/event-stream" \
  https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp
```

### Test with custom header (original method):
```bash
curl -H "x-brain-key: bf402ca9240a2d5481bf7314033b3d02cbb3a691a6efc871ccb72d8cf022227c" \
  -H "Accept: application/json, text/event-stream" \
  https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp
```

### Test MCP initialize handshake:
```bash
curl -X POST https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp \
  -H "Authorization: Bearer bf402ca9240a2d5481bf7314033b3d02cbb3a691a6efc871ccb72d8cf022227c" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
```

A successful response includes `"result"` with the server's capabilities. If you get an error, see the troubleshooting section — or just try again, sometimes the universe needs a second attempt.

## Troubleshooting

### "Failed to verify token"
**Cause:** Le Chat is sending authentication in a format the server doesn't recognize.

**Solution:** Ensure the server code includes the Bearer token fix:
```typescript
const provided = c.req.header("x-brain-key")
  || new URL(c.req.url).searchParams.get("key")
  || c.req.header("Authorization")?.replace("Bearer ", "");
```
And redeploy with `supabase functions deploy open-brain-mcp`.

*If it still fails: double-check the key. Yes, all 64 characters. Yes, including the hyphens.*

### "MCP connection requires additional information or is invalid"
**Possible causes:**
- Endpoint URL is incorrect (typo? copy-paste error?)
- Server is not reachable (check HTTPS/TLS — the internet is a fragile place)
- Authentication credentials are wrong (see above)
- MCP handshake is failing (the server might be having a bad day)

**Debug steps:**
1. Use [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) to test compatibility
2. Verify the server responds to `initialize` JSON-RPC call (see above)
3. Check that the access key matches exactly (character-by-character, like a password manager)

### Server returns 401
**Cause:** The access key doesn't match `MCP_ACCESS_KEY` environment variable on Supabase.

**Solution:** 
- Verify the key: `bf402ca9240a2d5481bf7314033b3d02cbb3a691a6efc871ccb72d8cf022227c`
- Check Supabase function environment variables
- Remember: Supabase restarts functions occasionally. Wait a minute and try again.

## Security Best Practices

1. **Vet every server** before connecting (don't trust random MCP servers on the internet — yes, even that one with the cute name)
2. **Start with manual approval** for all functions, only pre-authorize what you trust (paranoia is a virtue)
3. **Pre-authorize read functions** you use frequently to reduce prompts (lazy is efficient)
4. **Keep write functions on manual approval** until you're confident (or forever, no judgment)
5. **Monitor outputs** periodically for unexpected changes (AI can be sneaky)
6. **Guard against prompt injection** - review tool inputs and outputs for anything unexpected (yes, even that "harmless" request)

## Related Files

- **MCP Server:** `/home/christopher/programming/open-brain/supabase/functions/open-brain-mcp/index.ts`
- **Mistral Vibe MCP Config:** `/home/christopher/.claude/.mcp.json`
- **Setup Notes:** `/home/christopher/ai-workzone/AI-general-docs/my-personal-templates/openbrain set up`

## Support

If you find this useful, a small donation helps keep projects like this going:
[Donate via PayPal](https://paypal.me/christopherrehm001)

*No donation is too small. Unlike my ego.*
