# Company App Template

Use this repository as the reference for internal apps of the cloud.

Rules:

- Do not look for deploy patterns in other repositories before using this template.
- Do not copy old workflows.
- Never commit a `.env` with real secrets.
- Do not pick a fixed port for a new app; use `deploy.port: auto`.
- Do not publish straight to the host machine; a push to `main` is the deploy.
- In local development, do not use the SSO flow; use an explicit local mock such as `LOCAL_AUTH_MOCK_EMAIL`.
- In production, read the `X-authentik-*` headers sent by the proxy and never depend on the local mock.
- Validate the manifest with `node ../../src/cli.js validate ./company-app.yaml` before pushing.
