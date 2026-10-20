# Demo recordings

Three terminal recordings made on 2026-10-20 on clean Lima VMs (Ubuntu 26.04.1, 2 CPU, 4 GiB, Docker 29.9.1 rootless), from `main` at the time. Play one with `asciinema play docs/demo/<file>.cast`, or render it with [agg](https://github.com/asciinema/agg) (`agg <file>.cast <file>.gif`).

| File | What it shows | Real time | Recording |
|---|---|---|---|
| [`agent-install.cast`](agent-install.cast) | A coding agent installs the harness on a box with nothing of it, from a layperson's request in Portuguese | 419 s of agent time, the install 367 s of it | 1 min 31 s |
| [`agent-first-app.cast`](agent-first-app.cast), [`agent-first-app.gif`](agent-first-app.gif) | On that box, a new agent session gets "create an internal expense log app and put it on the air", then a check by hand: `/health` 200, `/` sent to the sign-in, the sign-in page | 107 s, request to report | 1 min 4 s |
| [`first-app-cli.cast`](first-app-cli.cast) | The same by hand, as in [`../try-it.md`](../try-it.md) step 5: `harness-app new --push`, `wait`, the checks | 38 s | 28 s |

## How they were made

The agent recordings repeat the method of [`../first-run.md`](../first-run.md) ("Cold install run" and "Cold agent run"): `claude -p` (Claude Opus 5.5) on the host, in a fresh clone of this repository, with no MCP servers, no user settings, slash commands off, and tools limited to `Read`, `Glob`, `Grep`, `Bash(ssh:*)` and `Bash(scp:*)`. It reached the VM only through `ssh`. Its output (`--output-format stream-json`) went through a small formatter that prints the agent's messages in full and each tool call and the last lines of its result in one line each. The person was simulated with `--resume`: the request, then the answers to its questions (a fictitious bakery, a fictitious email, only this machine, no separate disk for backups, no file storage, admin tools yes), then "sim, pode instalar".

The install run asked the same 6 questions as the earlier cold runs, showed the plan, installed, and reported **18 passed, 0 failed, 2 skipped** (the `storage` and `agent` profiles were off), the port-80 tunnel for a laptop, and the command that prints the sign-in password on the person's own screen. The app run took 13 turns: `harness-app new despesas`, a Node server on the shared Postgres, a build on the box, push, `harness-app wait`, a test row in and out through the container; the deploy run was green and `sso-login-check.sh` signed in to the app afterwards.

## What was edited

- **Pauses.** Every pause over 1.5 s was cut to 1.5 s, and a pause over 20 s is marked on screen where it happened ("… 5 min 48 s pass here"). The agent's longer messages scroll at reading speed. Nothing was reordered or removed.
- **Masked strings.** Paths of the recording machine and the name and email of its signed-in account were replaced (`/tmp/scratch`, `you`, `you@example.com`). In the install run the agent offered the account's email and a company name taken from the repository's commit history as default answers, as the earlier cold runs record; those two suggestions are masked as `you@example.com` and `acme`. The person's answers replaced them.
- **Secrets.** None to mask: the installer never prints a password, and the agent never read `.env`. Checked after recording: none of the 28 password, token, secret and key values in `.env` of either VM appears in any `.cast` file.
