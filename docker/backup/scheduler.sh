#!/bin/sh
# Entrypoint of the backup container: installs BACKUP_SCHEDULE as root's crontab and
# runs busybox crond in the foreground. The job's environment (credentials, settings)
# is captured once into a 0600 file that the cron line sources, because crond starts
# jobs with an empty environment. `docker compose exec backup harness-backup ...`
# runs the same script by hand at any time.
set -eu
: "${BACKUP_SCHEDULE:=0 2 * * *}"
umask 077
env | grep -E '^(BACKUP_|RESTIC_|POSTGRES_|AUTHENTIK_PG_|COMPOSE_|HARNESS_|TZ=|PATH=)' \
  | sed 's/^\([A-Za-z_][A-Za-z0-9_]*\)=\(.*\)$/export \1='"'"'\2'"'"'/' > /run/harness-backup.env
umask 022
mkdir -p /etc/crontabs
printf '%s . /run/harness-backup.env && /usr/local/bin/harness-backup run >>/proc/1/fd/2 2>&1\n' "$BACKUP_SCHEDULE" > /etc/crontabs/root
echo "harness backup scheduler: '$BACKUP_SCHEDULE' (TZ=${TZ:-UTC}), repository /backups/restic (BACKUP_DESTINATION on the host)" >&2
/usr/local/bin/harness-backup status || true
exec crond -f -l 6 -L /dev/stderr
