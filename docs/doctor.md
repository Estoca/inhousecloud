# ihc doctor

Is the cloud on the air, and if not, what to do. One command that checks the box the way the smoke tests do, read only, in a few seconds, and says for each problem what to run next.

```bash
cd /opt/inhousecloud && ./ihc doctor           # from the install directory
./install.sh doctor                            # from the checkout, the same
scripts/ihc-doctor.sh --install-dir /opt/inhousecloud --json   # for an agent or a script
```

`--verbose` adds the evidence of each check; `--json` prints `{checks, summary, generated_at}` for an agent ([`operator-contract.md`](operator-contract.md)). The exit code is 1 when a check fails.

## What it checks

The install and `state.json`, Docker, the containers, disk and memory, the proxy's routes, DNS and TLS for the ingress, the sign-in, Gitea and its runners, Postgres, Redis, the backup's age, every app in the inventory (its health path through the proxy), the operator agent when the `agent` profile is on, and how far this checkout is from `origin/main`. Each check answers `ok`, `warn` or `fail` in one line, and for `warn` and `fail` the action and the runbook that goes with it ([runbooks](runbooks/README.md)).

When the portal answers, `ihc doctor --json` and `install.sh status --json` read the platform's health from the [portal API](portal-api.md) and say `"source": "portal-api"`; otherwise `"local"`.

Which installation it checks: `--install-dir`, else `$IHC_INSTALL_DIR`, else the current directory when it is one, else `/opt/inhousecloud`, else the directory the running Compose project was started from.

## Inside the operator agent

The operator agent (the `agent` profile) has no Docker socket and no shell on the host. It runs `ihc-ro doctor` inside its container: the checks it can make through the read-only Docker API and the routes, plus the host's last report.

## How it was tested

On a clean VM, then with three failures caused on purpose (an app's container stopped, its proxy route deleted, the backup sidecar stopped and its last success made three days old): each was named in one line with the right action, and fixed by that action. About 3 seconds a run. The record: [doctor run](first-run.md#doctor-run).
