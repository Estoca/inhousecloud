# Stop or Remove an Installation

For a test install: stop it when you are done for the day, remove it when you are done with it. A cloud people use is not removed this way: its data lives in the volumes, and its backups are the way back ([`backup.md`](backup.md)).

`/opt/inhousecloud` below is the install directory; pass yours with `--install-dir` (on a Mac with Docker Desktop, `~/inhousecloud` in [`try-it.md`](try-it.md)).

## Stop, keeping everything

```bash
./install.sh stop --install-dir /opt/inhousecloud
```

Stops every container of the cloud and of its apps. Nothing is deleted: containers, volumes (users, repositories, databases), images and the install directory stay. Memory and CPU come back; disk does not.

```bash
./install.sh start --install-dir /opt/inhousecloud
```

Starts the same containers again; `./install.sh status` shows the health a minute later. A Docker restart (or a reboot) also brings the cloud back on its own: its containers restart unless they were stopped.

## Remove a test install

```bash
./install.sh remove --install-dir /opt/inhousecloud
```

It lists what goes, then asks you to type the Compose project name (`ihc`). For a script, `--confirm ihc` answers the question; anything else removes nothing. What each part is:

| Part | What it holds | `remove` | `remove --images` | `remove --dir` |
|---|---|---|---|---|
| Containers | the running services and apps: no data of their own | removed | removed | removed |
| Volumes | everything stateful: Authentik's users, Gitea's repositories, every Postgres database, Redis, object storage; also `act-toolcache`, the runners' job cache | **removed, for good** | removed | removed |
| Networks | `ihc`, `ihc-ops` and the apps' | removed | removed | removed |
| Built images | `ihc-portal`, `ihc-backup`, `ihc-deployer`, each app's image | removed | removed | removed |
| Pulled images | Authentik, Gitea, Postgres, Redis, the proxy...: about 5 GiB, the same for every install | kept | **removed** | kept |
| Install directory | `.env` (every password), `apps/`, `app-data/` (files the apps wrote), `local/` (keys, CA), and `backups/` when the backup is there | kept | kept | **removed** |

The backup destination is never touched when it is outside the install directory (another disk, as [`backup.md`](backup.md) recommends). With the defaults of the example config it is `/opt/inhousecloud/backups`, inside: `--dir` removes it. Keep the backup key and a copy of the repository if you might want the data back.

`remove` also takes the web terminal's key out of `~/.ssh/authorized_keys` (that one line) when the `ops` profile put it there. It leaves the repository checkout, any `/etc/hosts` lines you added, and the app folders you created with `ihc-app new` on your machine.

Everything at once, for a throwaway install:

```bash
./install.sh remove --images --dir --install-dir /opt/inhousecloud
```

### Doing it by hand

What `remove` runs, if you need a piece of it. Read the warnings first.

```bash
cd /opt/inhousecloud
```

- `docker compose stop`: stops; nothing deleted. Safe.
- `docker compose down`: removes the containers and networks. The volumes stay, so `install.sh --apply` brings the same cloud back.
- **`docker compose down -v`: also deletes every named volume of the project: every user, repository and database. No undo.** Only for a test install, or after a verified backup.
- **`docker image rm` / `docker image prune -a`: `prune -a` removes every image no container uses, including other projects' on this machine.** Remove images by name instead (`docker image ls`), as `remove --images` does with the names in `.env`.
- Apps are separate Compose projects named after their slug: `docker ps -a --filter label=com.docker.compose.project=<slug>` lists one's containers.
- `rm -rf /opt/inhousecloud` deletes `.env` and, with the default config, the backups. With rootless Docker some files there belong to container users; `install.sh remove --dir` removes those through a container.

## An installation made under a previous name

An installation made before a rename keeps the names it was made with (the table in [`install-design.md`](install-design.md#renamed-twice-open-company-app-harness-open-company-cloud-inhousecloud)): its Compose project, networks, volumes, app overlays, deploy runner and groups. This checkout does not operate it and does not migrate it: `install.sh` (`status`, `handoff`, `stop`, `start`, `remove`, `--plan`, `--apply`), `ihc-operator`, `ihc-app`, `ihc-backup` and `ihc doctor` stop with one message that names the old name and points here. The way forward is to remove it and install fresh. Nothing moves over by itself: copy out first what you want to keep (Gitea repositories, app databases).

| Made with | Prefix | Compose project | Its own `remove` |
|---|---|---|---|
| Open Company Cloud (2026-10-20 to 2026-10-21) | `occ` | `occ` | yes: a checkout of that time |
| Open Company App Harness (until 2026-10-20) | `harness` | `harness` | no: by hand, below |

**Open Company Cloud (`occ`).** Its `install.sh remove` does the whole job. In the checkout it was installed from, or in a fresh clone, go back to the last commit under that name and remove (it asks you to type `occ`):

```bash
git checkout 3a4f11a
```

```bash
./install.sh remove --images --dir --install-dir /opt/open-company-cloud
```

Then `git checkout main` and install fresh. On a Mac, the install directory is the one you gave then (`~/open-company-cloud` in the try-it of that time).

**Open Company App Harness (`harness`), or by hand for either.** Run these in the old install directory, with the prefix of the table in place of `harness` for an `occ` installation. Read the warnings in [Doing it by hand](#doing-it-by-hand) first: `down -v` deletes the data for good.

```bash
cd /opt/open-company-harness
```

Each app is its own Compose project, named after its folder in `apps/`. Remove them first, then the cloud itself, with its volumes and networks:

```bash
for d in apps/*/; do docker compose -p "$(basename "$d")" down -v --remove-orphans; done
```

```bash
docker compose -p harness down -v --remove-orphans
```

The images the installer and the deploys built (pulled images are shared and can stay; [Remove a test install](#remove-a-test-install) says which ones go with `--images`):

```bash
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^harness[-_]'
```

Remove those with `docker image rm`, and each app's image the same way (`docker image ls | grep <slug>`). What is left must be nothing; each of these prints an empty list:

```bash
docker ps -a --filter label=com.docker.compose.project=harness --format '{{.Names}}'
```

```bash
docker volume ls --filter label=com.docker.compose.project=harness --format '{{.Name}}'
```

```bash
docker network ls --format '{{.Name}}' | grep -E '^harness'
```

If the `ops` profile added the web terminal's key to `~/.ssh/authorized_keys`, take out the line that holds the key of `local/wetty/id_ed25519.pub`. Last, the directory, with `.env` and, with the defaults of that time, the backups (with rootless Docker some files there belong to container users: `sudo rm -rf` on Linux):

```bash
cd ~ && rm -rf /opt/open-company-harness
```

Then install fresh with this checkout ([`try-it.md`](try-it.md)), in a new directory or in the old one now that it is gone.

## Docker Desktop (macOS) keeps the space

Docker Desktop stores everything in one disk image on the Mac (`Docker.raw`). Removing images and volumes frees space inside it, but the space on the Mac's disk is not given back right away, and on the run recorded in [`first-run.md`](first-run.md#macos-run-docker-desktop) it was not given back by itself. What the image really takes:

```bash
du -h ~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw
```

The sure way to get all of it back is Docker Desktop > Troubleshoot > **Clean / Purge data**, which deletes every container, image and volume of Docker Desktop, not only this cloud's. Do it only when nothing else on the Mac uses Docker.

An install of `core` and `backup` took about 5.4 GiB in that disk image; keep 15 to 20 GiB free on the Mac before installing (the installer warns below 15). A Lima VM goes the same way: `limactl delete -f <name>` deletes the VM and its disk at once.

## Remove one app

`ihc-app remove <slug>` exists only for the app a system test created (smoke test 16 deploys `smoke-app` and removes it; if that removal fails, the app stays, marked `kind: system-test` and hidden from `ihc-app list`). It removes only what that app's deploy recorded in `inventory.json`: containers, database and role, Redis user and keys, bucket and key, Authentik application and provider, proxy host, the Gitea repository `<organization>/<slug>`, its env file, data directory and inventory record.

A real app has no automated removal yet: its data is someone's. By hand, after a backup: stop its containers (`docker compose -p <slug> down`), then remove its route in the proxy admin, its application and provider in Authentik, its repository in Gitea, its database and role, and its record in `inventory.json`.
