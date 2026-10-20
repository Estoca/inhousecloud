# Backup

The minimum backup of [`install-design.md`](install-design.md#backup), as built. One script, [`scripts/occ-backup.sh`](../scripts/occ-backup.sh), run on a schedule by a small container, writing an encrypted restic repository and a status file the portal reads.

## What a run does

1. Takes the lock (`<destination>/.lock`, an atomic `mkdir`). A second run while one is live refuses to start.
2. Starts a hard timeout of `BACKUP_MAX_RUN_MINUTES`. A run past it is killed with every child process (pg_dump, restic), recorded as `failed` with the reason, and the lock is released for tomorrow.
3. Opens the restic repository `<destination>/restic` with `BACKUP_ENCRYPTION_KEY`, creating it on the first run, and clears restic locks a killed run may have left.
4. For the shared Postgres and for Authentik's Postgres: `pg_dump -Fc` of every non-template database and `pg_dumpall --globals-only` (roles). Each dump streams from `pg_dump` through a sha256 counter straight into `restic backup --stdin`. Nothing is staged on disk.
5. Backs up the named volumes `gitea-data`, `proxy-data`, `proxy-letsencrypt`, `authentik-media`, `authentik-templates`, `authentik-certs`, and `garage-data` when the `storage` profile is on. They are read live, read-only. The databases are not among them: those are the dumps. Garage's metadata database in `garage-data` is copied live too; Garage also writes a consistent copy of it every 6 hours under `meta/snapshots/`, which a restore can start from if the live copy does not open.
6. Backs up the install directory (`config.yaml`, `.env`, `compose.yml`, `state.json`, `inventory.json`), without `backups/` and `local/`. The `.env` holds every generated secret, so it only exists inside the encrypted repository.
7. Applies retention per item (`restic forget --group-by host,tags --prune`): `BACKUP_RETENTION_DAILY` / `WEEKLY` / `MONTHLY`, 7/4/12 by default. Each dump, the volumes and the config are their own group, so one item never pushes another out.
8. Writes the manifest `reports/runs/<run_id>.json` (every item with its snapshot id; dumps with sha256 and size) and the status file. The last 100 manifests are kept.

The destination is a host directory: the interactive installer asks for it right after the Gitea organization; in a config file it is `backup.destination`; `OCC_BACKUP_DESTINATION` at install time wins over both; it is kept as `BACKUP_DESTINATION` in `.env`; default `<install-dir>/backups`. Point it at another disk or mount: preflight warns when it is on the same disk as the installation, and warns when it is not writable.

## The status file

`<destination>/reports/latest-status.json`, rewritten at the start and at the end of every run. This is the portal's contract:

```json
{
  "schema_version": 1,
  "status": "success",
  "run_id": "20261019T020000Z",
  "started_at": "2026-10-19T02:00:00Z",
  "finished_at": "2026-10-19T02:01:12Z",
  "duration_seconds": 72,
  "snapshot_id": "<restic snapshot id of the last item>",
  "error": null,
  "repository": "/backups/restic",
  "schedule": "0 2 * * *",
  "timezone": "UTC",
  "max_run_minutes": 240,
  "max_age_hours": 26,
  "manifest": "runs/20261019T020000Z.json",
  "manifest_sha256": "<sha256 of the manifest>",
  "items": 9,
  "bytes_dumped": 1843200
}
```

`status` is `running`, `success` or `failed`. A failed run carries `error` in words: the timeout, the step that failed, or "its process disappeared" when the container was stopped mid-run (the next run or `status` notices the dead lock and records it). `reports/latest-success.json` is a copy of the newest successful status; alarm on the age of its `finished_at` against `max_age_hours`, not on `latest-status.json` alone.

## Commands

From the host, with the install directory:

```bash
scripts/occ-backup.sh --install-dir /opt/open-company-cloud run
scripts/occ-backup.sh --install-dir /opt/open-company-cloud verify --latest [--json]
scripts/occ-backup.sh --install-dir /opt/open-company-cloud status [--json]
```

On the host the script only forwards to the backup container (`docker compose exec`, or a one-off `run` when the container is stopped), so the host needs no restic and no Postgres client.

- `run` exits non-zero on failure. The failure is also in the status file.
- `verify --latest` is smoke test 14. It checks that the newest run succeeded and is younger than `max_age_hours`, that the manifest matches the sha256 in the status file, and that the repository opens with the key. It then checks that every snapshot in the manifest exists, restores every dump through `restic dump` to compare its sha256 with the one recorded at backup time, and runs `restic check`.
- `status` prints the status file plus the age of the newest success and exits non-zero when it is stale or failed.

## Scheduling

The installer uses a **sidecar container**, `backup` in [`docker/compose.yml`](../docker/compose.yml), the Compose profile `backup`, on unless `backup.enabled: false`. Its image ([`docker/backup/Dockerfile`](../docker/backup/Dockerfile): Alpine, restic, the Postgres client matching `POSTGRES_IMAGE`) runs busybox `crond` with `BACKUP_SCHEDULE` in `BACKUP_TZ`. The job's output goes to the container log (`docker compose logs backup`).

Why not the host's cron: it works on Linux without root, but it would need restic and a Postgres client on the host, or a Docker call from cron, and on macOS cron jobs need Full Disk Access for many paths. The sidecar is the same on both and needs nothing on the host.

The host-cron alternative, if you prefer it, is one line in your user's crontab (`crontab -e`). Do not also leave the sidecar's schedule on, or the lock will refuse the second run.

```cron
0 2 * * * /path/to/open-company-cloud/scripts/occ-backup.sh --install-dir /opt/open-company-cloud run >> /opt/open-company-cloud/backups/reports/cron.log 2>&1
```

## Restoring

Run these inside the container, where restic and the key are present:

```bash
docker compose --project-directory /opt/open-company-cloud -f /opt/open-company-cloud/compose.yml exec backup sh
restic snapshots --tag item:shared-postgres__gitea.dump        # pick a snapshot
restic dump <snapshot> /shared-postgres__gitea.dump > /tmp/gitea.dump
```

Then restore into a scratch database to look, or into the real one with Gitea stopped:

```bash
PGPASSWORD="$POSTGRES_PASSWORD" createdb -h postgres -U "$POSTGRES_USER" gitea_restore
PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h postgres -U "$POSTGRES_USER" -d gitea_restore --no-owner /tmp/gitea.dump
```

Volumes and the config: `restic restore <snapshot> --target /tmp/restore --include /volumes/gitea-data`. Copying them back into a named volume is done with the service stopped.

Losing `.env` is recoverable only if you kept `BACKUP_ENCRYPTION_KEY` elsewhere: `.env` itself is inside the repository it unlocks.

## Next

Not built yet, in the order they matter:

- **Encrypted off-site copy** (`backup.remote`): `restic copy` to a second repository, S3-compatible or rclone, with its own key. A box that dies with its disks takes the local repository with it.
- **Monthly restore rehearsal** (`backup.restore_test`): restore one database per month into an isolated Postgres container, compare row counts, and restore everything once a year. Today `verify` proves the bytes are there, not that the restore works.
- **The portal's backup card** reading `latest-status.json` and alarming on age. That belongs to the portal project; the file is ready.
- Consistent volume snapshots (stopping Gitea for the length of its volume backup, or `gitea dump`), when a box has enough write traffic for a live copy to matter.
