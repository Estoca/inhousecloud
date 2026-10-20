# Disk pressure

**Purpose.** Get free space back without losing anything that cannot be rebuilt, and keep the margin that dumps and restores need. Low disk on a box with databases and backups is a capacity incident, not housekeeping.
**Level.** 1 to read. 2 to prune the Docker build cache, and to remove an image proved unreferenced, one by one, under an instruction. 3 for everything else: volumes, data, backups, images still referenced, anything outside Docker.
**Preconditions.** None to read.

## Read first, always

```bash
df -h / "$I" "$BACKUP_DESTINATION"                       # which file system is short
docker system df -v | sed -n '1,40p'                     # images, containers, volumes, build cache
du -xh --max-depth=2 "$I" 2>/dev/null | sort -h | tail -15
du -xh --max-depth=1 "$BACKUP_DESTINATION" 2>/dev/null | sort -h
```

*(agent)* `occ-ro df` (images, which are used by no container, build cache in use or not, volumes); the disk usage of the host itself needs the human.

Sort what you found into three kinds, and say which is which:

| Kind | Example | Rebuildable | Level |
|---|---|---|---|
| Build cache | `docker builder du` | yes, at the cost of slower builds | 2 |
| Images with no tag, or used by no container | superseded `<slug>-app` builds, `<none>:<none>` | yes, if its source is known (a commit on `main`, a public tag) | 2, one by one with the list |
| Images still referenced, volumes, `app-data/`, the restic repository, dumps | — | no | 3, and usually not at all |

## Act

```bash
docker builder prune -f                                   # build cache only (level 2)
docker image ls --filter dangling=true                    # show first
docker image rm <id> <id>                                 # only ids from the list shown, never -f
```

*(agent)* with `ops.agent.allow_write`: `POST /build/prune` through its Docker API; image removal is not on its allowlist: it shows the list and the human runs it.

Never by reflex: `docker system prune`, `docker image prune -a`, `docker volume prune`. Each removes things that look unused and are not (a stopped app's image, a volume of a service under a profile that is off).

On macOS with Docker Desktop, freed space stays inside Docker's virtual disk; set a maximum disk image size instead of compacting a running one.

## Post-checks

`df -h` again; report the space recovered and from what. Keep a margin of at least **twice the largest database dump** free on the file system where dumps are written, plus room for one image build. Before any migration, [database-migration](database-migration.md) checks this margin again.

## Example

On the first box free disk fell to about 14 GiB while dumps and image builds were running: build cache and superseded images had accumulated with every deploy (tens of GiB). Only the build cache and images verified to be referenced by no container were removed; no volume, database or mount was touched; later dumps were written straight to the backup disk. That margin is now a pre-check, not a discovery.
