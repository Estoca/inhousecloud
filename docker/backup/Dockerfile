# The backup job of the cloud (docs/backup.md): restic, the Postgres client and the
# ihc-backup script, driven by busybox crond on BACKUP_SCHEDULE. install.sh assembles
# the build context in <install-dir>/backup-job/ (this file, scheduler.sh and
# scripts/ihc-backup.sh) and builds it as <project>-backup:local.
#
# PG_CLIENT must match the major version of POSTGRES_IMAGE (pg_dump refuses a newer
# server). It comes from BACKUP_PG_CLIENT_PACKAGE in .env.
FROM alpine:3.22
ARG PG_CLIENT=postgresql16-client
RUN apk add --no-cache bash python3 restic coreutils tzdata ca-certificates "$PG_CLIENT" \
 && mkdir -p /backups /ihc /volumes /var/cache/restic
COPY ihc-backup.sh /usr/local/bin/ihc-backup
COPY scheduler.sh /usr/local/bin/ihc-backup-scheduler
RUN chmod 755 /usr/local/bin/ihc-backup /usr/local/bin/ihc-backup-scheduler
# Set for interactive use too (`compose exec backup restic snapshots`, docs/backup.md).
ENV IHC_BACKUP_CONTAINER=1 \
    RESTIC_REPOSITORY=/backups/restic \
    RESTIC_CACHE_DIR=/var/cache/restic \
    RESTIC_HOST=ihc
ENTRYPOINT ["/usr/local/bin/ihc-backup-scheduler"]
