# MCP in an App

Every app made with `ihc-app new` is born with tools for AI agents: the template's `company-app.yaml` has an `mcp` section and `server.js` answers a `ping` tool behind the gateway's token check. A person who connected Claude Code (or another MCP client) to the cloud's [MCP gateway](mcp-gateway.md) sees it as `<slug>__ping`, signed in as themselves. This page is the path from there to a useful tool; the rules are in the contract, [`app-contract.md`](app-contract.md#mcp).

## 1. What is already there

In `company-app.yaml`:

```yaml
mcp:
  audience: <slug>.mcp
  tools_path: /mcp/tools
  execute_path: /mcp/tools/{tool}/execute
  scopes:
    <slug>.read:
      - ihc-users
```

In `server.js`, a `TOOLS` map with `ping`, and the check every request to the two paths goes through first: an RS256 actor JWT signed by the gateway (`IHC_MCP_JWKS_URL`), with the right `iss`, `aud` and `exp`, and the scope the tool needs. The deploy gives the app `IHC_MCP_ISSUER`, `IHC_MCP_JWKS_URL` and `IHC_MCP_AUDIENCE` ([what the app receives](app-contract.md#what-the-app-receives)).

No tools wanted? Delete the `mcp` section and push: the app stays out of the gateway and nothing else changes.

## 2. Add a tool

Next to `ping` in `TOOLS`, a read-only tool that filters by the person calling (`actor.email`), the same rule the app applies to a browser user. The contract has a worked example, `list_my_expenses` ([`app-contract.md`](app-contract.md#mcp)). Keep the token check as it is; keep the tools read only in this layer.

## 3. Say who may call it

Each tool names a scope; `mcp.scopes` grants each scope to Authentik groups. Every scope starts with the slug. A narrower tool for a narrower group is a second scope:

```yaml
mcp:
  scopes:
    expenses.read:
      - ihc-users
    expenses.report:
      - finance
```

Someone whose groups hold none of the app's scopes never sees its tools, and the app is never called for them.

## 4. Push

`git push origin main`. The deploy validates the section (audience and scopes start with the slug, `execute_path` has `{tool}`, every scope is granted to a group) and copies it to the inventory; the gateway lists the app's tools on the next `tools/list`. In Claude Code: `/mcp`, reconnect, and the tool shows as `mcp__<server>__<slug>__<tool>`.

## How it was tested

A fresh install; a cold agent that, asked in plain words for an app it could later question through Claude, wrote one with a tool of its own next to `ping`; and Claude Code calling that tool with a person's Authentik token (the interactive OAuth sign-in from a browser was not part of the run): the [MCP gateway run](first-run.md#mcp-gateway-run).
