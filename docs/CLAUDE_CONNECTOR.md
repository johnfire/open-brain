# Open Brain — claude.ai Connector Guide (OAuth 2.1)

_First set up: 2026-08-04. For what the system **is**, see [OPEN_BRAIN_PLUS_PLUS.md](OPEN_BRAIN_PLUS_PLUS.md)._

## Why this is different from the Le Chat connector

[LECHAT_CONNECTOR.md](LECHAT_CONNECTOR.md) uses a static shared-secret bearer
token — Le Chat's connector UI lets you paste that token in directly. claude.ai's
custom-connector UI doesn't offer that; it only knows how to add a remote MCP
server via real OAuth (or no auth). Pointing it at the static-key endpoint
produces: *"Couldn't register with open brain's sign-in service"* — it's trying
to auto-register an OAuth client against a server that doesn't implement OAuth at
all.

The fix: Supabase Auth has a built-in OAuth 2.1 authorization server (currently
beta, free). `open-brain-mcp` now accepts **either** the original static key
(unchanged — Claude Code CLI and Le Chat need no changes) **or** a Supabase-issued
OAuth access token. claude.ai gets the latter.

## One-time project setup (dashboard only — not available via API/CLI)

In the [Supabase dashboard](https://supabase.com/dashboard/project/qaonmvqhlvrrvfkqcjbf):

1. **Authentication → OAuth Server**
   - Enable OAuth 2.1 server.
   - Authorization Path: `/functions/v1/open-brain-consent`
   - Enable "allow dynamic client registration" (lets claude.ai self-register —
     this is the piece that was missing).
2. **Authentication → URL Configuration**
   - Site URL: `https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1`
   - (Combines with the Authorization Path above to
     `.../functions/v1/open-brain-consent` — the consent page deployed alongside
     `open-brain-mcp`.)
3. **Authentication → Users**
   - Add yourself as a user (email + password, or magic link). This is the
     identity that owns every OAuth grant — the only account that can approve a
     connector.

## How the flow works

1. claude.ai calls the MCP endpoint → 401 with
   `WWW-Authenticate: Bearer resource_metadata="<mcp-url>/.well-known/oauth-protected-resource"`.
2. It fetches that URL (served by `open-brain-mcp` itself) →
   `{ "resource": "<mcp-url>", "authorization_servers": ["https://qaonmvqhlvrrvfkqcjbf.supabase.co/auth/v1"] }`.
3. It fetches Supabase's native discovery document at
   `https://qaonmvqhlvrrvfkqcjbf.supabase.co/.well-known/oauth-authorization-server/auth/v1`
   — lists the `authorize`, `token`, and `register` endpoints.
4. It dynamically registers itself as a client, then redirects your browser to
   the consent page (`open-brain-consent`) with an `authorization_id`.
5. You log in (first time) and click **Approve**. Supabase issues an access
   token; claude.ai sends it as `Authorization: Bearer <token>` on every call.

## Setting up the claude.ai connector

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Server URL: `https://qaonmvqhlvrrvfkqcjbf.supabase.co/functions/v1/open-brain-mcp`
3. Connect — claude.ai handles discovery/registration automatically and sends
   you to the consent page. Log in, click Approve.

No client ID/secret to enter manually — that's the whole point of dynamic client
registration being enabled above.

## Troubleshooting

- **"Couldn't register with open brain's sign-in service" (the original error)**
  — means OAuth 2.1 Server isn't enabled, or dynamic registration is off. Check
  step 1 above.
- **Consent page shows a login form every time** — expected on a fresh browser
  session; the Supabase session lives in that browser's storage. Logging in once
  per browser/device is normal.
- **401 after approving** — the issued token may have expired (short-lived
  access tokens, auto-refreshed by claude.ai using the refresh token). If it
  persists, re-run the connector setup.
- **General MCP debugging** — see the curl recipes in
  [LECHAT_CONNECTOR.md](LECHAT_CONNECTOR.md#testing-the-server); the
  `initialize` handshake test applies here too (just swap the auth header for a
  valid Supabase access token, or keep using the static key for manual testing).

## Deploying changes

```bash
cd ~/ppp2/open-brain
supabase functions deploy open-brain-mcp --no-verify-jwt
supabase functions deploy open-brain-consent --no-verify-jwt
```

## Security notes

- Dynamic client registration means any MCP client can register itself — but
  registering a client is not the same as getting a token. Every grant still
  requires you to log in and explicitly click Approve on the consent page, which
  shows the requesting client's name and redirect URI before you approve.
- The static `MCP_ACCESS_KEY` path is untouched; see
  [LECHAT_CONNECTOR.md](LECHAT_CONNECTOR.md#security) for its handling.
- Access tokens are standard Supabase JWTs, validated resource-side via
  `supabase.auth.getUser(token)` — same mechanism Supabase recommends for any
  OAuth-protected resource.

## Related files

- **MCP server (auth gate):** `~/ppp2/open-brain/supabase/functions/open-brain-mcp/index.ts`
- **Consent page:** `~/ppp2/open-brain/supabase/functions/open-brain-consent/index.ts`
- **System overview:** [OPEN_BRAIN_PLUS_PLUS.md](OPEN_BRAIN_PLUS_PLUS.md)
