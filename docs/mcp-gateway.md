# MCP Gateway

One MCP server for the whole cloud, at `https://mcp.<BASE_DOMAIN>/mcp`. A person connects Claude Code, claude.ai or any MCP client once, signs in with the company account (Authentik), and gets:

- the platform's own tools, read only: the app catalog for everyone in `ihc-users`; the platform status, people and groups for `ihc-admins`;
- the tools of every app whose `company-app.yaml` has an `mcp` section ([`app-contract.md`](app-contract.md#mcp)), named `<slug>__<tool>`, each app deciding what it returns for that person.

Nothing in this layer writes. The gateway keeps no session, no user data and no copy of anyone's permissions: who may use an app's tools is the app's manifest (scopes granted to groups) plus the app's own checks.

## Design

```text
MCP client ──OAuth 2.1 (code + PKCE)──▶ Authentik, provider ihc-mcp ──▶ access token (JWT)
     │
     └─ POST /mcp, Bearer <access token> ─▶ mcp gateway (service mcp, the portal's image)
                                              │ checks the token: signature (JWKS of ihc-mcp),
                                              │ iss, aud = ihc-mcp, exp; email and groups;
                                              │ in ihc-users or 403
                                              ├─ ihc_* tools: inventory, portal status API,
                                              │  Authentik (read-only service account)
                                              └─ <slug>__<tool>: actor JWT (aud, scope, person,
                                                 5 min) ─▶ http://<slug>:<port>/mcp/tools…
                                                          on the ihc network; the app checks it
                                                          against /.well-known/jwks.json
```

- **Same image as the portal.** `docker/compose.yml` runs `${project}-portal:local` a second time as service `mcp` with `node src/mcp-gateway.js` (`portal/src/mcp-gateway.js`), port 8090, on the `ihc` network only, uid 1000, no capability, the inventory read only. `install.sh` builds the image once (stage `foundation`), starts both in stage `portal`, and recreates both after `first-run`.
- **Transport.** MCP streamable HTTP, stateless, JSON responses: every request is a `POST /mcp` with one JSON-RPC message (or a batch); `GET` and `DELETE` on `/mcp` are 405 because there is no session and no server stream. Methods: `initialize`, `ping`, `tools/list`, `tools/call` (and empty `resources/list`, `prompts/list`). Protocol versions 2024-11-05 to 2025-11-25.
- **Route.** `mcp.<BASE_DOMAIN>` on the proxy, **without** forward auth: the client brings a bearer token, and the gateway answers `401` with `WWW-Authenticate: Bearer resource_metadata="…"` when it is missing or bad, which is how a client learns where to sign in. `/health`, `/.well-known/*` are public and carry no secret.

## Sign-in (OAuth)

`scripts/first-run.sh` (also on `install.sh --apply --from foundation`) creates and reconciles, every run:

| Object | Value |
|---|---|
| OAuth2 provider `ihc-mcp` | **public** client (no secret; `MCP_OIDC_CLIENT_ID` in `.env`, default `ihc-mcp`), grants `authorization_code` and `refresh_token`, PKCE, explicit consent (a program on the laptop cannot get a token silently), scopes `openid email profile offline_access`, access tokens 1 hour, refresh tokens 30 days, signed with Authentik's key (RS256), issuer per provider |
| Redirect URIs | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, and the loopback rule `^http://(localhost\|127\.0\.0\.1\|\[::1\])(:[0-9]+)?/(oauth/)?callback$` (Claude Code, MCP Inspector, other local clients); more strict URLs from `MCP_OAUTH_EXTRA_REDIRECT_URIS` (comma separated) in `.env`. Editing them in Authentik is undone by the next first-run: use the variable |
| Application `ihc-mcp` ("MCP gateway") | bound to `ihc-users`: Authentik refuses anyone else at sign-in |
| Proxy host `mcp.<BASE_DOMAIN>` | to `mcp:8090`, no forward auth |

The sequence a client goes through:

1. `POST /mcp` without a token → `401`, `WWW-Authenticate: Bearer resource_metadata="https://mcp.<BASE_DOMAIN>/.well-known/oauth-protected-resource/mcp"`.
2. `GET` that URL (RFC 9728) → `{"resource": "https://mcp.<BASE_DOMAIN>/mcp", "authorization_servers": ["https://auth.<BASE_DOMAIN>/application/o/ihc-mcp/"], …}`. The same document is at `/.well-known/oauth-protected-resource`; `/.well-known/oauth-authorization-server` on the gateway lists Authentik's endpoints for clients of the 2025-03-26 specification.
3. The client reads `https://auth.<BASE_DOMAIN>/application/o/ihc-mcp/.well-known/openid-configuration` and opens the browser on the `authorize` endpoint with `client_id=ihc-mcp`, its redirect URI, `code_challenge` (S256) and `state`.
4. The person signs in (password, MFA if set) and consents once. Not in `ihc-users`: Authentik shows "access denied" and no code is issued.
5. The client exchanges the code with its `code_verifier` at the `token` endpoint and keeps the access and refresh tokens.
6. Every `POST /mcp` carries `Authorization: Bearer <access token>`. The gateway checks the signature against the provider's JWKS (read inside the network, `http://authentik-server:9000/application/o/ihc-mcp/jwks/`, cached 5 minutes, read again when an unknown `kid` arrives), `iss`, `aud = ihc-mcp` and `exp`. It takes `email` and `groups` from the token, or from Authentik's `userinfo` when the token lacks them (cached until the token expires). Not in `ihc-users` (`USER_GROUP`): `403` with `error="insufficient_scope"`. In `ihc-admins` (`ADMIN_GROUP`): admin tools too.

Authentik down: `503`, never a `401` that would make the client discard a good token.

## Tools of the platform

| Tool | Who | What |
|---|---|---|
| `ihc_list_apps` | `ihc-users` | every app of the catalog (and the portal): name, description, owner, URL, health (its health path through the proxy), SSO (required by the manifest, effective at `/`), and `mcp`: whether it has a provider, its prefix `<slug>__`, and whether the caller has access. Apps a smoke test created only for admins. Optional `query` |
| `ihc_platform_status` | `ihc-admins` | the JSON of the portal's `GET /api/platform/status` ([`portal-api.md`](portal-api.md)), read with `IHC_PORTAL_API_TOKEN` from inside the network |
| `ihc_list_people` | `ihc-admins` | Authentik's users (username, name, email, active, groups), through the read-only service account `ihc-portal` (`AUTHENTIK_PORTAL_TOKEN`) |
| `ihc_list_groups` | `ihc-admins` | Authentik's groups and members, the same way |

The rule is the portal's: someone in `ihc-users` sees the catalog and the apps' health, not the machine's detail nor the list of people. Admin tools are not listed for others, and calling one answers an error result ("access denied").

## Tools of the apps

The providers are the apps of `inventory.json` whose record has `mcp` (copied from the manifest on every deploy; see [`app-contract.md`](app-contract.md#mcp)). An app without the section is not a provider and nothing of it appears. For each `tools/list`:

1. For every provider, the scopes of its manifest granted to the caller's groups. None: the app is **not called** and its tools are not listed.
2. The other providers are listed **in parallel**, each with `MCP_TOOLS_LIST_TIMEOUT_MS` (10 s): `GET http://<slug>:<runtime.port><tools_path>` with a fresh actor JWT.
3. Each tool comes back as `<slug>__<name>` with `[App name]` before its description. The slug never contains `__`, so the prefix always says which app a call goes to.
4. **Fallback.** When a provider is down, slow or answers 5xx, the gateway serves that provider's last good list for that person, kept in memory for `MCP_CATALOG_FALLBACK_SECONDS` (24 h). Without it a client (claude.ai keeps the list it got) would lose the app's tools until someone refreshes. A `403` never uses the fallback and drops the kept list: a revocation applies at once.

`tools/call` with `<slug>__<tool>`: the provider of the prefix; no granted scope → error result "access denied: <slug> grants its MCP scopes to <groups>, and <email> is in none of them", without calling the app; otherwise `POST http://<slug>:<port><execute_path with {tool}>` with `{"arguments": {...}}` and a fresh actor JWT, `MCP_TOOL_CALL_TIMEOUT_MS` (30 s). The app's `{"result": …}` comes back as the tool's result (text and, for an object, `structuredContent`); its `403`, `404` and `400` come back as error results with the app's message; `401` means the app rejected the gateway's token (wrong issuer, JWKS URL or audience in its env).

## Actor JWT

The gateway signs one per request to an app, RS256 with its own key:

```json
{
  "iss": "https://mcp.<BASE_DOMAIN>",
  "aud": "<slug>.mcp",
  "sub": "ana@example.com",
  "email": "ana@example.com",
  "name": "Ana",
  "username": "ana",
  "groups": ["ihc-users"],
  "scope": "<slug>.read",
  "client_id": "ihc-mcp",
  "request_id": "…", "jti": "…",
  "iat": 1761140000, "nbf": 1761140000, "exp": 1761140300
}
```

- **Lifetime** `MCP_ACTOR_TTL_SECONDS`, 300 by default, clamped to 30 to 900.
- **Key.** RSA 2048 in the `mcp-keys` volume (`/ihc/mcp-keys/actor-key.pem`, 0600, uid 1000), created on the gateway's first start; never in `.env`, Git or the logs. The public half is at `/.well-known/jwks.json` (also `http://mcp:8090/.well-known/jwks.json` inside the network) with its `kid`. To rotate: delete the volume's file and restart `mcp`; apps read the JWKS again when they see a new `kid`. The volume is a Compose volume like the others; losing it only rotates the key.
- **What the app checks** is in [`app-contract.md`](app-contract.md#mcp): signature against that JWKS, `iss`, `aud`, `exp`, and the scope each tool needs.

## Connecting a client

Every client needs the URL `https://mcp.<BASE_DOMAIN>/mcp` and the OAuth client id (`MCP_OIDC_CLIENT_ID`, `ihc-mcp`; `install.sh status` and the handoff print both). There is no client secret.

**Claude Code** (on a computer that reaches the cloud's names):

```bash
claude mcp add --transport http --client-id ihc-mcp --scope user company https://mcp.cloud.example.com/mcp
```

Then `/mcp` in Claude Code, pick `company`, authenticate: the browser opens Authentik; after the consent the tools show up as `mcp__company__ihc_list_apps`, `mcp__company__notes__ping`, … With TLS `internal`, the computer must trust the cloud's CA ([`first-user.md`](first-user.md)); with `local` ingress, only the box itself (or an SSH tunnel of port 80, which keeps `*.localhost` names) reaches the gateway.

**claude.ai** (Settings → Connectors → Add custom connector): name, URL `https://mcp.<BASE_DOMAIN>/mcp`, and under advanced settings the OAuth Client ID `ihc-mcp`, no secret. claude.ai calls the gateway from the internet, so this needs `public` ingress (or a tunnel that publishes `mcp.<BASE_DOMAIN>`); with `local` or `private` ingress use Claude Code.

**Any MCP client** that supports protected resource metadata and PKCE: the URL and the client id. One without OAuth support can be given a token by hand (`scripts/sso-login-check.sh --oauth-token FILE` on the box writes one, valid one hour); never paste it in a chat.

## Configuration

| Variable (`.env` → service `mcp`) | Default | Meaning |
|---|---|---|
| `MCP_BASE_URL` | `<scheme>://mcp.<BASE_DOMAIN>` | public URL: the resource, and the actor JWT's issuer (written by the foundation stage) |
| `MCP_OIDC_CLIENT_ID` | `ihc-mcp` | the Authentik provider and application (first-run) |
| `MCP_OAUTH_EXTRA_REDIRECT_URIS` | empty | more strict redirect URIs for other clients |
| `MCP_ACTOR_TTL_SECONDS` | 300 | actor JWT lifetime |
| `AUTHENTIK_APP_GROUP`, `AUTHENTIK_PORTAL_GROUP` | `ihc-users`, `ihc-admins` | who enters, who is admin |
| `IHC_PORTAL_API_TOKEN`, `AUTHENTIK_PORTAL_TOKEN` | first-run | the platform status and the people tools |

Inside the service (compose, not `.env`): `MCP_TOOLS_LIST_TIMEOUT_MS` 10000, `MCP_TOOL_CALL_TIMEOUT_MS` 30000, `MCP_CATALOG_FALLBACK_SECONDS` 86400.

## Operating it

- Health: `GET https://mcp.<BASE_DOMAIN>/health` (`ok`, commit, the actor key's `kid`); the portal's platform status lists "Gateway MCP"; `ihc doctor` checks the container and the route.
- Logs: `docker compose … logs mcp` has one line per refused sign-in (reason, never the token), per failed provider list (`<slug> provider_timeout`, `serving the last good catalog`) and per tool call (`<tool> by <email>: ok | <code>`).
- Smoke test 25 ([`smoke-tests.md`](smoke-tests.md)) proves the whole path on every install.
- What is not here yet (later layers): write tools, per-tool grants beyond a scope, an audit log in the portal, dynamic client registration.
