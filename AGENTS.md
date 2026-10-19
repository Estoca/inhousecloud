# Agent Instructions

This repository is designed to be operated by terminal-connected coding agents.

If a user asks you to set up this repository on a machine, follow this order:

1. Read `README.md`.
2. Read `docs/agent-setup-contract.md`.
3. Read `docs/llm-bootstrap.md`.
4. Inspect `docs/install-design.md`, `docker/compose.yml`, `bootstrap/config.example.yaml`, `install.sh` and `templates/app/`.
5. Explain the proposed single-box cloud before changing the machine.
6. Ask for the values `bootstrap/config.example.yaml` needs and write them to a local config file (ignored by Git).
7. Run `./install.sh --plan --config <file>` and show the plan.
8. Ask for explicit approval before `./install.sh --non-interactive --config <file>`, and before anything that creates public routes or DNS records.
9. Keep generated config and secrets out of Git; never print the values in `.env`.
10. Read `./install.sh status --json` and report what changed and what remains human (`docs/first-run.md`).

The target architecture is a single-box internal cloud:

```text
user -> tunnel -> reverse proxy -> auth gateway -> app
```

Supported by:

- Git server and automation;
- Docker Compose runtime;
- app portal / orchestrator;
- Portainer;
- Glances;
- shared services such as Postgres and Redis;
- GitOps deploy requests;
- app manifests and health checks.

Default to safety. Do not delete existing repositories, volumes, databases, proxy routes, or auth config. If the host already contains services, inspect and preserve them by default.
