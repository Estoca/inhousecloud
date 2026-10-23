# What an Agent Does

Two requests, each one sentence from a person who does not need to know the stack:

```text
"Set up this machine as our company cloud."
"Build an internal app for expense reports and put it on the air."
```

What a terminal-connected agent does with them, today:

1. Reads [`AGENTS.md`](../AGENTS.md), which routes it to [`agent-setup-contract.md`](agent-setup-contract.md) (what to ask, what never to do) and [`llm-bootstrap.md`](llm-bootstrap.md) (the commands, with success conditions).
2. **Install.** Asks for the install directory, ingress mode and domain, admin email, Gitea organization, backup destination and optional profiles; never for a password (the installer generates them). Shows `./install.sh --plan`, applies after a yes, and reports the URLs and the steps left to the human. Four to seven minutes on a clean box.
3. **App.** Runs `scripts/ihc-app.sh new <slug>`, writes the app in the generated repository (shared Postgres and Redis through `DATABASE_URL` and `REDIS_URL`, the user from the SSO headers), pushes to `main`, and confirms the deploy run is green, `/health` answers 200 and `/` asks for the sign-in.
4. **Repair.** On a red run, reads the job log, fixes the app and pushes again.

The test of this is a cold run: an agent given only the repository and a one-line request in a layperson's words. Results in [`first-run.md`](first-run.md#cold-agent-run), "Cold agent run", and for the install, [`first-run.md`](first-run.md#cold-install-run), "Cold install run".

Once the cloud is up, an agent off the box reads its health through the portal's status API with a read-only token ([`portal-api.md`](portal-api.md)), and a person's AI client uses the cloud through the MCP gateway, signed in as that person ([`mcp-gateway.md`](mcp-gateway.md)). An operator agent on the box (the `agent` profile) answers "why is it down" inside its own contract ([`operator-contract.md`](operator-contract.md)).

`private` ingress (Tailscale, own CA, split DNS, `https://<app>.<domain>` on the tailnet only) is tested end to end: [`install-design.md`](install-design.md#private-ingress-private--internal--tailscale). `public` ingress, for a cloud reachable from the internet, comes later.

The cloud should also expose live app-building rules for day-to-day app creation. See [`app-rules-example.md`](app-rules-example.md) for a generalized example based on a real internal app platform rules file.
