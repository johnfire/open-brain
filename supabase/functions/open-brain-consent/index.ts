import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Consent screen for Open Brain's OAuth 2.1 server (Authentication > OAuth Server
// authorization path). Single-user: Chris logs in once with his Supabase Auth
// account, then approves/denies whichever MCP client (claude.ai, etc.) is asking.
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Open Brain — Authorize</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 420px; margin: 4rem auto; padding: 0 1.5rem;
    color: #1a1a1a; background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #eaeaea; background: #14141a; }
    input { background: #1f1f28; color: #eaeaea; border-color: #3a3a46; }
    .card { border-color: #333; }
  }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  p.sub { color: #888; margin-top: 0; font-size: 0.9rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.25rem; margin-top: 1.5rem; }
  label { display: block; font-size: 0.85rem; margin: 0.75rem 0 0.25rem; }
  input {
    width: 100%; box-sizing: border-box; padding: 0.5rem 0.6rem;
    border: 1px solid #ccc; border-radius: 6px; font-size: 0.95rem;
  }
  button {
    margin-top: 1rem; padding: 0.55rem 1rem; border-radius: 6px; border: none;
    font-size: 0.95rem; cursor: pointer;
  }
  .approve { background: #2563eb; color: #fff; }
  .deny { background: transparent; color: #888; border: 1px solid #ccc; margin-left: 0.5rem; }
  .row { display: flex; align-items: center; }
  .err { color: #dc2626; font-size: 0.85rem; margin-top: 0.75rem; }
  .kv { font-size: 0.85rem; margin: 0.4rem 0; word-break: break-all; }
  .kv b { color: #666; font-weight: 500; }
  ul { margin: 0.4rem 0; padding-left: 1.2rem; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>Open Brain</h1>
  <p class="sub">Authorize an application to access your memory</p>
  <div id="app" class="card">Loading…</div>

<script type="module">
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient("${SUPABASE_URL}", "${SUPABASE_ANON_KEY}");
const app = document.getElementById("app");
const params = new URLSearchParams(window.location.search);
const authorizationId = params.get("authorization_id");

function renderError(message) {
  app.innerHTML = \`<p class="err">\${message}</p>\`;
}

function renderLogin(message) {
  app.innerHTML = \`
    <form id="login-form">
      <label for="email">Email</label>
      <input id="email" type="email" required autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" type="password" required autocomplete="current-password" />
      <div class="err" id="login-err">\${message || ""}</div>
      <button class="approve" type="submit">Log in</button>
    </form>
  \`;
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      document.getElementById("login-err").textContent = error.message;
      return;
    }
    run();
  });
}

function renderConsent(details) {
  const scopes = (details.scope || "").trim();
  const scopeHtml = scopes
    ? \`<div class="kv"><b>Requesting:</b></div><ul>\${scopes
        .split(" ")
        .map((s) => \`<li>\${s}</li>\`)
        .join("")}</ul>\`
    : "";
  app.innerHTML = \`
    <div class="kv"><b>Application:</b> \${details.client?.name || "Unknown client"}</div>
    <div class="kv"><b>Redirects to:</b> \${details.redirect_uri || "?"}</div>
    \${scopeHtml}
    <div class="row">
      <button class="approve" id="approve">Approve</button>
      <button class="deny" id="deny">Deny</button>
    </div>
    <div class="err" id="consent-err"></div>
  \`;
  document.getElementById("approve").addEventListener("click", async () => {
    const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId);
    if (error) return (document.getElementById("consent-err").textContent = error.message);
    window.location.href = data.redirect_url;
  });
  document.getElementById("deny").addEventListener("click", async () => {
    const { data, error } = await supabase.auth.oauth.denyAuthorization(authorizationId);
    if (error) return (document.getElementById("consent-err").textContent = error.message);
    window.location.href = data.redirect_url;
  });
}

async function run() {
  if (!authorizationId) {
    renderError("No pending authorization request. This page is only meaningful when an MCP client (like claude.ai) sends you here.");
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    renderLogin();
    return;
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error) {
    renderError(error.message);
    return;
  }
  if (!("authorization_id" in data)) {
    // Already consented previously — Supabase returns a direct redirect.
    window.location.href = data.redirect_url;
    return;
  }
  renderConsent(data);
}

run();
</script>
</body>
</html>`;

Deno.serve(() => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }));
