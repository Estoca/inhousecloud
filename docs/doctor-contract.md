# The doctor contract (iho, iha, ihc), version 2

One report shape for the three products, so iht can run any of them over SSM and show the
result without knowing which product answered. It extends the shape `ihc doctor --json`
already prints (`docs/operator-contract.md` in InHouseCloud): every field that exists today
keeps its name and meaning; version 2 adds `product`, `mode`, `commit`, the `repair` and
`repaired` fields of a check, and three counts in `summary`.

Reference: `openclaw doctor` (https://docs.openclaw.ai/cli/doctor/checks): report by default,
`--fix` for the supported repairs only, `--lint` strictly read-only.

## Command line

    ./install.sh doctor [--json] [--verbose] [--lint] [--fix [--yes]]

(ihc also keeps `<install-dir>/ihc doctor` and `scripts/ihc-doctor.sh`, same flags.)

| Mode | What it may change |
|---|---|
| no flag (`mode: "report"`) | nothing on the box. ihc keeps writing its own report file (`agent/reference/doctor.json`), as today. |
| `--lint` (`mode: "lint"`) | nothing at all, not even its own report file. |
| `--fix` (`mode: "fix"`) | only the repairs marked `safe: true`, each after a backup. Asks before each one on a terminal; without a terminal it needs `--yes`, else it applies nothing, says so, and exits as a report would. `--json --fix` without `--yes` is the same as without a terminal. |

`--fix` and `--lint` together is an error (exit 2).

Exit status: 0 when no check is `fail` after the run, 1 when one is, 2 for a usage error.
Human output goes to stderr; with `--json`, stdout carries only the JSON document.

## The JSON document

```json
{
  "doctor_version": 2,
  "product": "iho",
  "mode": "report",
  "generated_at": "2026-11-03T01:02:03Z",
  "install_dir": "/home/ubuntu/inhouseos",
  "commit": "bf6d4b7bc089...",
  "duration_seconds": 3.2,
  "checks": [
    {
      "name": "running-commit",
      "status": "fail",
      "detail": "the server runs e4fae39341a0 and the checkout is bf6d4b7bc089",
      "action": "./install.sh --apply --no-pull",
      "runbook": "",
      "evidence": ["state.env INSTALLED_COMMIT=e4fae39341a0", "git rev-parse HEAD=bf6d4b7bc089"],
      "repair": {"id": "apply-checkout", "description": "update the server to the checkout's commit (snapshot first, data kept)", "safe": true, "command": "./install.sh --apply --no-pull --yes --non-interactive"},
      "repaired": {"ok": true, "detail": "updated to bf6d4b7bc089", "backup": "/home/ubuntu/iho-backups/iho-20261103T010203Z.tar.gz"}
    }
  ],
  "summary": {"ok": 11, "warn": 1, "fail": 0, "fix_now": 0, "recommended": 1, "repaired": 1},
  "not_applicable": [{"name": "tls-certificate", "reason": "HTTPS_MODE=tunnel"}]
}
```

Fields of a check:

* `name`: stable, kebab-case, never reused for another meaning. Tests and iht key on it.
* `status`: `ok`, `warn` or `fail`, **after** any repair of this run (a repaired check is re-checked).
* `detail`: one line, what was seen.
* `action` and `runbook`: only when not `ok`; the next step a person or agent takes, with the literal command.
* `evidence`: list of short strings. **Redacted by value**: the secret values the product holds (8 characters or longer) are replaced by `[redacted]` wherever they appear: every value of `server/.env` and `.iho/tunnel.env` / `.iha/tunnel.env`; in ihc, the secret-named keys of the install's `.env` (it also holds settings such as domains, profiles and runner names, which stay readable) and every value of the app and agent env files. Also anything that looks like a token (`eyJ...`, `ghp_`, `gho_`, `sk-`, a long hex or base64 run of 32+ characters), except the commits the report names. `commit` is never redacted: a full hex commit, `-dirty` when the checkout has local changes, or `unknown`. Never print a secret to find out whether it is a secret.
* `repair` (optional): present when the doctor knows a repair, whether or not it is safe.
  * `id`: stable, kebab-case.
  * `description`: one line.
  * `safe`: `true` only when the repair is idempotent, never deletes company data, takes a backup (or the product's snapshot) before writing, and does not need a person's decision. Everything else is `false` and only ever printed as the next step.
  * `command`: the literal command, runnable from the install directory.
* `repaired` (only in `--fix` mode, only on checks whose repair was attempted): `ok` (bool), `detail`, and `backup` (path of what was saved before writing, or `null` when the repair writes nothing that existed).

`summary`:

* `ok`, `warn`, `fail`: counts after the run (as ihc prints today).
* `fix_now`: checks still `fail`.
* `recommended`: checks still `warn`.
* `repaired`: checks with `repaired.ok == true` in this run.

The human output ends with the same three groups, in this order: **Fix now**, **Recommended**,
**Repaired**, each listing `name: detail` and, for the first two, the action.

## Backups before a repair

A safe repair that writes or removes a file first copies it to
`<install_dir>/.<product>/doctor-backups/<UTC timestamp>/<relative path>` (ihc:
`<install_dir>/doctor-backups/<UTC timestamp>/...`), mode 0700 on the directory, and records that
path in `repaired.backup`. A repair that updates the server uses the product's own snapshot
(iho `backup-now`, iha's database copy before `--apply`) and records its path when known.
