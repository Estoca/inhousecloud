# Repository Layout

```text
AGENTS.md              Agent instructions for terminal-connected LLMs
mkdocs.yml             This site, built from docs/ (mkdocs build --strict)
docs/                  Architecture, install design, GitOps flow, app contract, backup, security
docs/try-it.md         The ten-minute path for a person; docs/demo/ has the recordings
docs/first-run.md      What the install automates, what it leaves to you, and every test record
docs/llm-bootstrap.md, docs/agent-setup-contract.md   The agent path
docs/operator-contract.md, docs/runbooks/             The operator agent (agent profile)
docs/mcp-gateway.md, docs/portal-api.md               The cloud for agents: MCP gateway, status API
schemas/               JSON schema for company-app.yaml
templates/app/         The app template ihc-app new copies: runnable app, manifest, deploy workflow, MCP tool
portal/                The app portal and the MCP gateway (core services, read only; portal/README.md)
examples/minimal-web-app/  A minimal web app
docker/                compose.yml (core with the Actions runners; profiles storage, ops, backup, agent,
                       cloudflared, tailscale), .env.example, backup/ and deployer/ images
install.sh             One-command installer: plan, apply, resume, status
scripts/first-run.sh   First access: Gitea admin and org, Authentik OIDC, portal route
scripts/ihc-app.sh new, provision, checkout, wait, list: the app loop (docs/gitops-flow.md)
scripts/ihc-backup.sh run, verify, status: the nightly backup (docs/backup.md)
scripts/ihc-doctor.sh  Is it on the air, and what to do if not (also install.sh doctor, <install-dir>/ihc doctor)
scripts/smoke-tests.sh The checks that decide "installed"
scripts/sso-login-check.sh  Walks the sign-in with curl, the way a browser would
scripts/ihc-operator.sh brief: the generated map an operator reads first (docs/operator-contract.md)
scripts/lib/, scripts/tests/  Helpers (Authentik and proxy, Garage, env files, state, this site's hooks) and their tests
bootstrap/             config.example.yaml and state.example.json for the installer
packages/cli/          Placeholder for validation and workflow tooling
```

Browse it on GitHub: [the repository](https://github.com/Estoca/inhousecloud).
