# Try It in 10 Minutes

The shortest path for a person (not an agent) to see the cloud working on their own computer: one install command, the portal behind the sign-in, and a first app on the air. Two paths, both tested:

| | Mac with Docker Desktop | Lima VM (macOS) |
|---|---|---|
| For | a Mac that already runs Docker Desktop | a Mac without Docker, or when you want a throwaway VM |
| Where it runs | on the Mac, in `~/inhousecloud` | in an Ubuntu VM with Docker rootless |
| Steps | [below](#mac-with-docker-desktop), then 4 and 5 | 1 to 5 |
| Undo | `install.sh remove` ([`cleanup.md`](cleanup.md)) | `limactl delete -f ihc` |
| Tested | Mac mini (Apple Silicon), 2026-10-20: 17 smoke tests, first app in 16 s | MacBook (Apple Silicon), 2026-10-20: times below |

**Linux laptop, a VM or a VPS:** Ubuntu (tested: 26.04) with 2 CPUs, 4 GiB of memory (6 GiB with the operator agent), 10 GiB free disk, Docker Engine usable without `sudo` (rootless, or your user in the `docker` group) with Docker Compose v2, `git`, `curl` and `python3`, and `sudo` for one command. Follow the Lima path from step 2, on that machine.

Times of the Lima path, run as written on a clean VM:

| Step | Time |
|---|---|
| 1. VM created and started (Ubuntu 26.04, Docker rootless) | 62 s |
| 2. Clone the repository | 1 s |
| 3. Install, all stages and the smoke tests | about 5 min |
| 4. Portal in the browser, sign in | about 1 min, by hand |
| 5. First app: `ihc-app new --push` until it answers behind the sign-in | about 30 s |

Step 3 downloads the container images (5.4 GB once unpacked), so a slow connection adds to it.

## Mac with Docker Desktop

What the Mac needs:

- **Docker Desktop running**, with Compose v2 (it ships with it). No `sudo` anywhere below.
- **The install directory shared with Docker Desktop.** The cloud's containers mount files from it. Docker Desktop shares `/Users` by default, so `~/inhousecloud` works as is; a directory outside it (such as `/opt/...`) must be added in Docker Desktop > Settings > Resources > File sharing first.
- **Disk: 15 to 20 GiB free.** The images and volumes take about 5.4 GiB inside Docker Desktop's disk image, and that file does not give space back to the Mac by itself ([`cleanup.md`](cleanup.md#docker-desktop-macos-keeps-the-space)). The installer warns below 15 GiB and stops below 10.
- **Port 80 free** on the Mac (no other web server, no VM forwarding it).
- **Names under `cloud.localhost` resolving to the Mac.** Check before installing:

```bash
ping -c 1 portal.cloud.localhost
```

It should print `127.0.0.1` (macOS 26 does; so do Chrome, Firefox, Edge and `curl` on their own). If it says it cannot resolve the name, add this line to `/etc/hosts` (with `sudo`), plus one name per app you create later:

```text
127.0.0.1 portal.cloud.localhost auth.cloud.localhost git.cloud.localhost
```

Then, in a terminal on the Mac: the repository in `~/src`, the cloud in `~/inhousecloud`.

```bash
git clone https://github.com/Estoca/inhousecloud.git ~/src/inhousecloud && cd ~/src/inhousecloud
```

```bash
./install.sh --plan --config bootstrap/config.example.yaml --install-dir ~/inhousecloud
```

```bash
./install.sh --non-interactive --config bootstrap/config.example.yaml --install-dir ~/inhousecloud
```

`--plan` is optional: it checks the Mac and prints what would be created, and creates nothing (not even the directory). The install ends with the seven day-zero steps shown in step 3 below, with the commands for these paths. Continue at step 4; wherever it says `/opt/inhousecloud`, use `~/inhousecloud`, and `~/src/inhousecloud` for the repository.

## 1. A clean VM (macOS)

```bash
brew install lima
```

```bash
limactl start --tty=false --name ihc --cpus 2 --memory 4 --disk 30 template:docker
```

```bash
limactl shell ihc
```

You are now in a shell inside the VM. Lima's `docker` template brings Docker rootless and Compose; Lima also forwards the VM's port 80 to the Mac's, which is what lets the Mac's browser open the apps in step 4.

## 2. Clone

Inside the VM (the `cd ~` matters: `limactl shell` starts in your Mac folder, mounted read-only):

```bash
cd ~ && git clone https://github.com/Estoca/inhousecloud.git && cd inhousecloud
```

## 3. Install

The install directory is under `/opt`, so create it once for your user, then install with the example answers:

```bash
sudo install -d -o $(id -un) -g $(id -gn) /opt/inhousecloud
```

```bash
./install.sh --non-interactive --config bootstrap/config.example.yaml
```

Without the first command the installer stops in one second and prints that same command. The example config means: everything on this machine only (`local` ingress, names under `cloud.localhost`), admin `admin@example.com`, Gitea organization `company`, backup on the same disk, no optional profiles. The installer generates every password into `/opt/inhousecloud/.env` (mode 0600) and never prints one. Add `--plan` first to see what it would do; it creates nothing. The install ends with the URLs and seven day-zero steps (from the run of 2026-10-20; `~` is the VM user's home):

```text
smoke tests: 17 passed, 0 failed, 4 skipped
...
Day zero, in this order:
1. Open the portal: http://portal.cloud.localhost
   It is a placeholder: it proves the SSO. To operate, use Gitea and ihc-operator brief (step 6).
2. Read the first password here, in your own terminal (never paste it into a chat):
     python3 ~/inhousecloud/scripts/lib/envfile.py get /opt/inhousecloud/.env AUTHENTIK_BOOTSTRAP_PASSWORD
3. Sign in at http://auth.cloud.localhost/if/user/ as akadmin. Settings > MFA Devices > Enroll: an authenticator app,
   then Static tokens (keep those recovery codes off this machine). Then Settings > Change password.
   Gitea (http://git.cloud.localhost): use "Sign in with authentik". Its local admin 'admin' (GITEA_ADMIN_PASSWORD in .env) is break-glass only.
4. Copy the backup key off this machine (a password manager): without it no backup can be read.
     python3 ~/inhousecloud/scripts/lib/envfile.py get /opt/inhousecloud/.env BACKUP_ENCRYPTION_KEY
5. Your first app: a folder here, a repository in Gitea, deployed by the push:
     ~/inhousecloud/scripts/ihc-app.sh new my-first-app --owner admin@example.com --push --install-dir /opt/inhousecloud
6. Operate: the map of services, apps, owners and commands:
     ~/inhousecloud/scripts/ihc-operator.sh brief --install-dir /opt/inhousecloud
   Short state: ~/inhousecloud/install.sh status --install-dir /opt/inhousecloud
   Something looks wrong? Ask the doctor: it says what is broken and what to do:
     /opt/inhousecloud/ihc doctor
7. Only a test? Stop it (data kept) or remove it and get the space back (docs/cleanup.md):
     ~/inhousecloud/install.sh stop --install-dir /opt/inhousecloud
     ~/inhousecloud/install.sh remove --install-dir /opt/inhousecloud
People: docs/first-user.md (groups ihc-users and ihc-admins; mail, password recovery and invitations are off).
```

`./install.sh handoff` prints these steps again. Whenever something looks wrong later, `cd /opt/inhousecloud && ./ihc doctor` checks the whole box in a few seconds and prints, for each problem, what to do. The 4 skipped tests belong to the optional profiles (`ops`, `storage`, `agent`) and to `private` ingress. Smoke test 16 deploys a test app (`smoke-app`) and removes it afterwards, so `ihc-app list` starts empty. Run `./install.sh` without arguments instead to answer the questions yourself; [`../README.md`](../README.md#install) has the options.

## 4. Open the portal

On the Mac, in Chrome, Edge or Firefox: <http://portal.cloud.localhost>. It sends you to the company sign-in (Authentik). Sign in as `akadmin`; the password is on the VM, and this prints it on your screen:

```bash
python3 ~/inhousecloud/scripts/lib/envfile.py get /opt/inhousecloud/.env AUTHENTIK_BOOTSTRAP_PASSWORD
```

The portal is a placeholder today: it proves the SSO. To operate, use Gitea (<http://git.cloud.localhost>, "Sign in with authentik") and `ihc-operator brief` (step 6 of the day-zero list). Before anything else, do steps 3 and 4 of that list: MFA and a new password for `akadmin`, and the backup key off the machine.

- `*.cloud.localhost` names resolve to `127.0.0.1` on their own in Chrome, Edge, Firefox and `curl` (tested on macOS 26.7). If one does not resolve (Safari, some older systems), add `127.0.0.1 portal.cloud.localhost auth.cloud.localhost git.cloud.localhost` (and each app's name) to `/etc/hosts` on the Mac, or use another browser.
- On a VPS or a VM with no port forwarding, keep `sudo ssh -N -L 80:127.0.0.1:80 <user>@<box>` open on your laptop first. It must be port 80: the sign-in redirect drops any other port.

## 5. Your first app

Still inside the VM, from your home directory:

```bash
cd ~ && alias ihc-app=~/inhousecloud/scripts/ihc-app.sh
```

```bash
ihc-app new pedidos --owner admin@example.com --push
```

```bash
cd pedidos && ihc-app wait pedidos
```

`new` creates the app from `templates/app` (a small Node server, its `company-app.yaml`, compose file and deploy workflow), creates the private repository `company/pedidos` in Gitea and pushes `main`. The push is the deploy: Gitea Actions on the box gives the app its own database and role on the shared Postgres, a Redis user, an env file, the route `pedidos.cloud.localhost` behind the sign-in and a line in the inventory, then builds and starts it. `wait` (run inside the app folder: it reads `company-app.yaml`) returns when `/health` answers 200 through the proxy and an anonymous `/` is sent to the sign-in:

```text
[ok] pedidos.cloud.localhost/health answers 200 through the proxy
[ok] anonymous requests to / are sent to the Authentik sign-in
[ok] pedidos is up at http://pedidos.cloud.localhost
```

Open <http://pedidos.cloud.localhost> on the Mac: "pedidos is running on the company cloud". <http://pedidos.cloud.localhost/me> shows the user the app received from the sign-in. The deploy run is at `http://git.cloud.localhost/company/pedidos/actions`.

Recording of this step: [`demo/first-app-cli.cast`](demo/first-app-cli.cast) (`asciinema play docs/demo/first-app-cli.cast`).

## 6. Make it do something

The app is a repository; every push to `main` redeploys it, keeping its passwords. The intended way to write it is a coding agent with the repository and `ssh` to the box. On the Mac, in a clone of this repository:

```bash
ssh -F ~/.lima/ihc/ssh.config lima-ihc true && echo "ssh ok"
```

Then ask the agent in your own words, with that `ssh` command, for example: "Change the app pedidos on our company cloud so each person records orders (date, customer, item, amount) and sees their own list. Server access: `ssh -F ~/.lima/ihc/ssh.config lima-ihc`." It reads [`../AGENTS.md`](../AGENTS.md) and [`llm-bootstrap.md`](llm-bootstrap.md); section 2.4 there is how a push is made from the box. In the cold test an agent that had never seen the cloud put a new app like this on the air in 113 s and 141 s ([`first-run.md`](first-run.md#cold-agent-run)); a recording of the same kind of request is in [`demo/`](demo/).

## Clean up

Lima: the VM and its disk go at once.

```bash
limactl delete -f ihc
```

Mac with Docker Desktop, or any box: stop it and keep the data, or remove it. `remove` lists what goes and asks you to type the project name (`ihc`); `--images` also removes the pulled images (about 5 GiB) and `--dir` the install directory with `.env` and the backups. Docker Desktop then still holds the space in its disk image until you purge it ([`cleanup.md`](cleanup.md)).

```bash
./install.sh stop --install-dir ~/inhousecloud
```

```bash
./install.sh remove --images --dir --install-dir ~/inhousecloud
```

## What this does not show yet

- **Reaching it from other computers.** `private` ingress (Tailscale) is tested end to end: every app at `https://<slug>.<domain>` on the tailnet only, with the installation's own CA and split DNS; it needs a Tailscale auth key and one DNS setting in the Tailscale admin console ([`install-design.md`](install-design.md#private-ingress-private--internal--tailscale)). `public` (Cloudflare tunnel or DNS) exists in the installer and is not tested end to end. `local`, used here, answers on the box (and on the Mac through Lima's forward).
- **The portal.** A placeholder answers today; the read-only portal with inventory, deploy runs, health and backups is next ([`../README.md`](../README.md#roadmap)).
- **Mail.** Authentik and Gitea are installed with SMTP off: no password recovery and no invitations; an admin creates each person and sets the first password ([`first-user.md`](first-user.md)).
