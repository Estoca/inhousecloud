# Incident record

**Purpose.** Write every incident down in the same structure, so it becomes something the next operator (and the next version of this repository) can learn from, and a regression test for the runbooks.
**Level.** 1.
**Where.** The agent profile keeps records in its workspace, `<install-dir>/agent/workspace/incidents/YYYY-MM-DD-<slug>.md`. Otherwise wherever the team keeps them; one file per incident.

## Template

```markdown
---
id: YYYY-MM-DD-<short-slug>
severity: 1 | 2 | 3            # 1 down for everyone or data at risk; 2 one app or one team; 3 degraded, no one blocked
status: open | mitigated | resolved
services: [<compose service or app slug>, ...]
runbooks: [<runbook used>, ...]
---

## Timeline (UTC)
- HH:MM  first signal: who saw what, where
- HH:MM  each observation, hypothesis, action, with who decided

## Symptom
What users or checks saw. Exact status codes and messages, not "it was down".

## Cause
Confirmed, with the evidence that confirmed it. If not confirmed: "suspected", and what would confirm it.

## Impact
Who and what, for how long. Data lost or at risk: yes or no, and how you know.

## Decision
What was decided, by whom, when (every level-3 action has an ok here).

## Fix
What changed, exactly (command, object id, commit). How it can be undone.

## Prevention
The rule, check, test or runbook change this leaves. "Be more careful" is not one.

## Evidence
Commands and their relevant output (no secrets), log excerpts, run links.

## Not checked
What could still be wrong.
```

## Example (anonymized, from the first box)

```markdown
---
id: day-12-backup-blocked-by-os-prompt
severity: 2
status: resolved
services: [backup]
runbooks: [backup-stuck]
---

## Timeline (UTC)
- day 10 02:00  nightly backup starts on the host scheduler
- day 12 09:30  the portal's backup card shows the newest success 54 h old; the operator reads the status: "running"
- day 12 09:35  process alive, CPU ~0, log silent, repository size unchanged across two readings, lock held
- day 12 09:40  the OS privacy log shows an access request for the backup binary pending a user decision
- day 12 09:49  the admin clicks "allow" (decision: admin)
- day 12 10:15  the run finishes: 15.0 GiB read, 749 MiB new, partial check without errors

## Symptom
Backup "running" for ~54 h; the next two nightly runs refused by the lock.

## Cause
An operating-system privacy prompt (macOS TCC) blocked the binary's open() on a protected folder until someone answered. Confirmed by the OS privacy log naming the binary and the path.

## Impact
No new backup for two nights. No data lost; the previous snapshots verified.

## Decision
Let the run resume after the click rather than kill it (admin).

## Fix
Permission granted to the binaries that open the path; binaries pinned; lock, 4 h timeout, JSON progress and a failed status added to the job.

## Prevention
Unattended jobs never depend on a prompt; after any upgrade of the pinned binaries, run once interactively. Check the reports mount at each release of the portal.

## Evidence
status file before and after; two size readings; process tree; privacy log line (path redacted).

## Not checked
Whether other scheduled jobs on the host read protected folders.
```
