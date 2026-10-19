# Backup late, failed or stuck

**Purpose.** Tell a backup that is working slowly from one that is stuck, failed, or never ran, and get a verified snapshot again.
**Level.** 1 to read and to run `verify` and `status`. 3 to stop a run, release a lock, change the schedule, the destination or the key, or start a manual run while another may be alive.
**Preconditions.** Backup enabled (`BACKUP_ENABLED=true`). The job is the `backup` sidecar container; its contract is [`backup.md`](../backup.md).

## Read first

```bash
$H/scripts/harness-backup.sh --install-dir "$I" status --json     # status, age of the newest success, stale or not
cat "$BACKUP_DESTINATION/reports/latest-status.json"
ls -l "$BACKUP_DESTINATION/.lock" 2>/dev/null && cat "$BACKUP_DESTINATION/.lock/"{pid,host,started} 2>/dev/null
dc ps backup; dc logs --since 24h --tail 50 backup
df -h "$BACKUP_DESTINATION"; mount | grep -F "$BACKUP_DESTINATION"   # is the destination the disk you think it is
```

*(agent)* `harness-ro backup`, `harness-ro logs backup 50`, `harness-ro inspect backup`; the lock and the mount need the human.

| What you see | Meaning |
|---|---|
| `success`, newest success younger than `max_age_hours` | fine; `verify --latest` to be sure |
| `failed` with `error` | the error says the step (a dump, the repository, the timeout). Fix that, then a manual run (level 3: say what it will do) |
| `running` | is it progressing? Next section |
| newest success older than `max_age_hours`, nothing running | the schedule did not fire: is the container up, is crond alive (`dc exec backup pgrep crond`), is the destination mounted |

## Is a "running" backup progressing?

A live process is not success. Measure twice, a few minutes apart:

```bash
du -s "$BACKUP_DESTINATION/restic"                                  # repository size, now and in 5 minutes
dc top backup                                                       # restic and pg_dump still there
docker stats --no-stream "$(dc ps -q backup)"                       # CPU and block I/O, now and in 5 minutes
```

*(agent)* `harness-ro docker /containers/<id>/stats` twice, and `harness-ro docker /containers/<id>/top`

- Size and I/O grow: slow, not stuck. Leave it; the hard timeout (`BACKUP_MAX_RUN_MINUTES`) is the ceiling.
- No growth, no CPU, no I/O, log silent: stuck. Something is blocking a read or a write: the destination (an unmounted or full disk, a network mount that hung), or the host refusing access.

The harness's own job cannot hang forever: past `BACKUP_MAX_RUN_MINUTES` it is killed and recorded as `failed`, the lock is released, and a lock whose process is gone is reaped by the next run. A stuck run within the timeout is waited out or, with an ok, stopped with `dc restart backup` (the run is recorded as failed; the next one starts clean).

## Verify after any fix

```bash
$H/scripts/harness-backup.sh --install-dir "$I" run              # level 3 when in doubt about another live run
$H/scripts/harness-backup.sh --install-dir "$I" verify --latest  # manifest, checksums, every dump restored and compared, restic check
```

Smoke test 14 is the same `verify`. Report the snapshot id, its age, and what `verify` checked.

## Example: the operating-system prompt

On the first box, whose backup ran from the host's scheduler on macOS, a backup of about 15 GiB looked stuck for about 54 hours: CPU near zero, the log silent, its lock refusing every later run. The cause was not restic and not file permissions: the operating system's privacy control (TCC) was waiting for someone to click "allow" so the backup binary could open a protected folder, and at night nobody was there. After the click, the run finished in 25 minutes (15 GiB read, about 750 MiB new).

What it left, for any box:

- **Unattended jobs never depend on a prompt.** Grant the permission to the binary that actually opens the path (on macOS it is tied to the binary's path), and run it once interactively after installing or upgrading it, so the prompt appears while someone is there.
- **Pin the binaries** the permission is tied to; a package-manager upgrade changes the path and brings the prompt back.
- **Lock, hard timeout, JSON progress and a failure status** on the job. The harness's sidecar has all four; it also runs in a container, where no such prompt exists, which is the reason it is the default.
- **Check the reports mount on every release of whatever reads the status** (the portal): a rebuild once dropped it, and the backup card went blank while backups were fine.
