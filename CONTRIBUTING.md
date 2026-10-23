# Contributing

InHouseCloud is an installer and a handful of scripts that put a company cloud on one machine, plus the portal (`portal/`). A change here runs as root-equivalent on someone's box, so the bar is a change that was run, not only read. This page says how to test, how to open a pull request, and what is not accepted.

## Running the tests

Three levels, from seconds to a quarter of an hour. CI ([`.github/workflows/portal.yml`](.github/workflows/portal.yml)) runs the first two on every pull request.

**The portal** (Node 20):

```bash
cd portal && npm ci && npm test && npm run build
```

`portal/scripts/check-private-names.sh` runs in CI before them: it fails if a tracked file or path contains a name from the private list (kept as SHA-256 hashes, so the names never appear in clear).

**The cloud's side, without a box.** Each script in [`scripts/tests/`](scripts/tests/) is self-contained (Bash and Python 3, fixtures in `scripts/tests/fixtures/`) and exits non-zero on the first failure:

```bash
for t in scripts/tests/*.sh; do bash "$t" || echo "FAILED: $t"; done
```

The header of each script says what it covers (the inventory contract, the status API, the portal's roles, the MCP gateway, the ops mounts, the legacy install detection, and so on). `mcp-gateway.sh` also runs a portal test, so run `npm ci` in `portal/` first. A change to `install.sh` or `scripts/lib/` that one of them covers comes with the test updated.

**A real install, on a clean VM.** Anything that touches the installer, a stage, the deploy job, `ihc-app`, `ihc-backup`, `ihc doctor` or the portal's wiring is tested on a clean box before review. Follow [`docs/try-it.md`](docs/try-it.md) (the Lima path takes about ten minutes): it ends with the smoke tests ([`docs/smoke-tests.md`](docs/smoke-tests.md)) and a first app on the air. Delete the VM afterwards (`limactl delete -f ihc`). The smoke tests also run on their own on an installed box:

```bash
scripts/smoke-tests.sh --install-dir /opt/inhousecloud
```

## Opening a pull request

- **One subject per pull request.** A fix, a stage, a profile, a doc. Two unrelated changes are two pull requests, even when they are small.
- **A record when it touches the installer or the portal.** Add a section to [`docs/first-run.md`](docs/first-run.md) with what was run, on what box (VM, CPU, memory, Docker version), the commands and the results (smoke test counts, times, what failed and why). The existing sections are the model; a record says what was not covered, too.
- **The private names sweep.** Before pushing, look for names of real installations, people, companies, IP addresses and paths of your own machine in the diff, for example:

  ```bash
  git diff main... | grep -n -i -E '/Users/|/home/[a-z]|([0-9]{1,3}\.){3}[0-9]{1,3}|@[a-z0-9-]+\.(com|com\.br|io)'
  ```

  Use the placeholders the docs already use: `acme`, `company`, `admin@example.com`, `cloud.localhost`, `/opt/inhousecloud`, `<user>@<box>`.
- **`.env.example` is the contract.** A new variable an app or the platform reads goes into the matching `.env.example` (`docker/`, `templates/app/`, `portal/`, the examples) with a placeholder and a comment, in the same pull request. Never a real value.
- **Docs move with the code.** A new command, flag, stage or variable is documented where a person or an agent will look for it: `README.md`, `AGENTS.md`, the contracts in `docs/`, the runbooks.
- The pull request template asks for these as a checklist. A maintainer merges; please do not merge your own.

## Commit messages

Look at `git log` for the style. In short:

- English, one line, no trailing period: `area: what changed`, where the area is the part of the repository (`install`, `portal`, `first-run`, `docs`, `tests`, `ihc doctor`, a profile name).
- Say what the change does, in plain words, with the detail that matters: `install: copy_portal normalizes the modes of the copied tree`, `tests: copy-portal-perms reads the mode with GNU stat first`.
- A record gets its own commit: `first-run.md: MCP gateway run (update from main, fresh install, cold agent, real client)`.
- A body, when the why is not obvious from the line.

## What is not accepted

- **Secrets of any kind**: passwords, tokens, keys, `.env` files, a Tailscale auth key, a private key, even a revoked one. The installer generates every credential on the box; nothing in this repository needs one. A commit that had one is rewritten before merge, and the secret is rotated.
- **Names of real installations**: company names, people, domains, internal hostnames, IP addresses, account emails, paths of the machine you tested on. In code, docs, test fixtures, screenshots and terminal recordings alike.
- Changes that loosen a rule of [`docs/security.md`](docs/security.md) (an app that brings its own database, mounts the Docker socket or uses host networking; a deploy on a pull request event; a command that deletes a database, volume or repository on its own) without a discussion in an issue first.
- Large refactors with no test run on a box.

## Reporting a vulnerability

Not in an issue: see [`SECURITY.md`](SECURITY.md).
