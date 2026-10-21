# InHouseCloud CLI

Placeholder for a future `company-deploy` CLI.

The app loop already has a command line: [`scripts/ihc-app.sh`](../../scripts/ihc-app.sh) (`new`, `provision`, `checkout`, `wait`, `list`), a bash script like the rest of the installer, so the box needs nothing but bash, python3, curl, git and Docker. It is installed as `ihc-app` in the deploy jobs' image ([`docker/deployer`](../../docker/deployer/Dockerfile)). See [`docs/gitops-flow.md`](../../docs/gitops-flow.md).

What a packaged CLI could add later, for laptops:

- `company-deploy validate ./company-app.yaml` (today: `python3 scripts/lib/appmanifest.py vars company-app.yaml`);
- `company-deploy checks ./company-app.yaml`;
- `company-deploy env-plan ./company-app.yaml`.

The CLI should never apply production changes unless explicitly designed, documented, and protected by policy.
