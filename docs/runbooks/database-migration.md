# Database migration

**Purpose.** Change an app's schema or data on the shared Postgres with a way back.
**Level.** 3 for anything not purely additive (and for any change to a core database: Gitea's, the portal's, Authentik's). A purely additive migration (new table, new nullable column, new index built concurrently) that ships in a release already approved on `main` runs as part of that release, with the dump below still taken.
**Preconditions.** The migration's text, read in full. The app's database and role: `app_<slug>` for both ([`app-contract.md`](../app-contract.md)).

## Classify first

| Kind | Examples | Level |
|---|---|---|
| additive | `CREATE TABLE`, `ADD COLUMN ... NULL`, `CREATE INDEX CONCURRENTLY` | 2 inside an approved release |
| changing | `ALTER COLUMN TYPE`, `SET NOT NULL`, renames, data backfills | 3 |
| destructive | `DROP`, `TRUNCATE`, `DELETE` without a narrow `WHERE` | 3, and say what is lost |
| locking | anything that rewrites or locks a large table | 3, with a time window |

Say whether it can be reversed and how (a down migration, a restore of the dump).

## Read first

```bash
set -a; . "$I/.env"; set +a
dc exec -T postgres psql -U "$POSTGRES_USER" -d app_<slug> -Atc "select pg_size_pretty(pg_database_size('app_<slug>'))"
dc exec -T postgres psql -U "$POSTGRES_USER" -d app_<slug> -c '\dt+'
df -h "$BACKUP_DESTINATION"                 # room for the dump: see disk-pressure.md
```

*(agent)* it has no database credential: it reads the migration in the repository (`occ-ro gitea /repos/<org>/<slug>/contents/<path>`), classifies it, and hands the human these commands.

## Dump before, restorable, kept

```bash
mkdir -p "$BACKUP_DESTINATION/manual-migrations"
f="$BACKUP_DESTINATION/manual-migrations/app_<slug>-$(date -u +%Y%m%dT%H%M%SZ).dump"
dc exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc app_<slug> > "$f"
dc exec -T postgres pg_restore --list < "$f" | head -5      # the dump opens: it is restorable
ls -l "$f"
```

Write the dump to the backup disk, not the system disk. **Never delete it** afterwards; it is the rollback. Record its path, size and time.

## Run

The migration runs the way the app runs it (its start command, or a one-off with its own role), never as the superuser unless the migration itself needs a privilege the role lacks, which is a level-3 question on its own:

```bash
docker compose -p <slug> exec app <the app's migrate command>
```

Capture the output.

## Post-checks

- The app's health and one real request that touches the changed tables (checks 5 and 6).
- `\d <table>` shows the new shape.
- Report: the migration, its class, the dump path, the result, and the rollback (`pg_restore -U "$POSTGRES_USER" -d app_<slug> --clean --if-exists < "$f"`, level 3).

## Example

On the first box, before a migration that dropped a write surface from the portal's database, a custom-format dump went to the backup disk in a folder for manual migrations, the migration ran through the approved connection, the app was tested, and the dump stayed where it was. Free disk had fallen low weeks before during dumps ([disk-pressure](disk-pressure.md)); since then, the margin is checked first.
