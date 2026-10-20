# Try It in 10 Minutes

The shortest path for a person (not an agent) to see the cloud working on their own laptop: a throwaway Ubuntu VM, one install command, the portal behind the sign-in, and a first app on the air.

Everything below was run as written on 2026-10-20, on a MacBook (Apple Silicon) with Lima 2.2 and a home connection. The times are from that run.

| Step | Time |
|---|---|
| 1. VM created and started (Ubuntu 26.04, Docker rootless) | 62 s |
| 2. Clone the repository | 1 s |
| 3. Install, all stages and 16 smoke tests | 313 s |
| 4. Portal in the browser, sign in | about 1 min, by hand |
| 5. First app: `occ-app new --push` until it answers behind the sign-in | about 30 s |

About 8 minutes, most of it waiting for the install. Step 3 downloads the container images (5.4 GB once unpacked), so a slow connection adds to it.

## What you need

**macOS with Docker Desktop:** nothing else. The cloud installs directly on the Mac, with no VM: see [Mac with Docker Desktop](#mac-with-docker-desktop-no-vm) below, then continue at step 4.

**macOS without Docker, or if you want a throwaway VM:** [Homebrew](https://brew.sh), and port 80 of the Mac free (nothing else listening on it, no other VM forwarding it). Lima runs the VM; Docker Desktop is not needed. Steps 1 to 5 below.

**Linux laptop, a VM or a VPS:** Ubuntu (tested: 26.04) with 2 CPUs, 4 GiB of memory, 10 GiB free disk, Docker Engine usable without `sudo` (rootless, or your user in the `docker` group) with Docker Compose v2, `git`, `curl` and `python3`, and `sudo` for one command. Skip step 1 and run the rest on that machine.

## Mac with Docker Desktop (no VM)

Docker Desktop running, with Compose v2, port 80 of the Mac free and about 10 GiB of free disk (the images take about 5.4 GiB). In a terminal on the Mac, no `sudo`, the install directory in your home (any path you own; `~/occ-install` here):

```bash
cd ~ && git clone https://github.com/Estoca/open-company-cloud.git && cd open-company-cloud
./install.sh --non-interactive --config bootstrap/config.example.yaml --install-dir ~/occ-install
```

Then follow steps 4 and 5 on the Mac itself, with `~/occ-install` wherever they say `/opt/open-company-cloud`. Tested on 2026-10-20 on a Mac mini (Apple Silicon, macOS 26.7, Docker Desktop with Docker 29.8 and Compose v5.5): core and backup, 17 smoke tests passed and 4 skipped (the profiles left off), a first app deployed by push in 16 s ([`first-run.md`](first-run.md#macos-run-docker-desktop)).

## 1. A clean VM (macOS)

```bash
brew install lima
```

```bash
limactl start --tty=false --name occ --cpus 2 --memory 4 --disk 30 template:docker
```

```bash
limactl shell occ
```

You are now in a shell inside the VM. Lima's `docker` template brings Docker rootless and Compose; Lima also forwards the VM's port 80 to the Mac's, which is what lets the Mac's browser open the apps in step 4.

## 2. Clone

Inside the VM (the `cd ~` matters: `limactl shell` starts in your Mac folder, mounted read-only):

```bash
cd ~ && git clone https://github.com/Estoca/open-company-cloud.git && cd open-company-cloud
```

## 3. Install

The install directory is under `/opt`, so create it once for your user, then install with the example answers:

```bash
sudo install -d -o $(id -un) -g $(id -gn) /opt/open-company-cloud
```

```bash
./install.sh --non-interactive --config bootstrap/config.example.yaml
```

Without the first command the installer stops in one second and prints that same command. The example config means: everything on this machine only (`local` ingress, names under `cloud.localhost`), admin `admin@example.com`, Gitea organization `company`, backup on the same disk, no optional profiles. The installer generates every password into `/opt/open-company-cloud/.env` (mode 0600) and never prints one. It ends with:

```text
smoke tests: 16 passed, 0 failed, 4 skipped
==> handoff

Installed. URLs:
  portal     http://portal.cloud.localhost   (forward auth through Authentik)
  authentik  http://auth.cloud.localhost   (user akadmin)
  gitea      http://git.cloud.localhost   (user admin; SSH port 2222; sign in with Authentik)
```

The 4 skipped tests belong to the optional profiles (`ops`, `storage`, `agent`). Run `./install.sh` without arguments instead to answer the questions yourself; [`../README.md`](../README.md#install) has the options.

## 4. Open the portal

On the Mac, in Chrome, Edge or Firefox: <http://portal.cloud.localhost>. It sends you to the company sign-in (Authentik). Sign in as `akadmin`; the password is on the VM, and this prints it on your screen:

```bash
python3 ~/open-company-cloud/scripts/lib/envfile.py get /opt/open-company-cloud/.env AUTHENTIK_BOOTSTRAP_PASSWORD
```

The portal is a placeholder today (it says it is running); the point is the sign-in in front of it. <http://git.cloud.localhost> is Gitea, with "Sign in with authentik".

- `*.cloud.localhost` names resolve to `127.0.0.1` on their own in Chrome, Edge, Firefox and `curl` (tested on macOS 26.7). If one does not resolve (Safari, some older systems), add `127.0.0.1 portal.cloud.localhost auth.cloud.localhost git.cloud.localhost` (and each app's name) to `/etc/hosts` on the Mac, or use another browser.
- On a VPS or a VM with no port forwarding, keep `sudo ssh -N -L 80:127.0.0.1:80 <user>@<box>` open on your laptop first. It must be port 80: the sign-in redirect drops any other port.

## 5. Your first app

Still inside the VM, from your home directory:

```bash
cd ~ && alias occ-app=~/open-company-cloud/scripts/occ-app.sh
```

```bash
occ-app new pedidos --owner admin@example.com --push
```

```bash
cd pedidos && occ-app wait pedidos
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
ssh -F ~/.lima/occ/ssh.config lima-occ true && echo "ssh ok"
```

Then ask the agent in your own words, with that `ssh` command, for example: "Change the app pedidos on our company cloud so each person records orders (date, customer, item, amount) and sees their own list. Server access: `ssh -F ~/.lima/occ/ssh.config lima-occ`." It reads [`../AGENTS.md`](../AGENTS.md) and [`llm-bootstrap.md`](llm-bootstrap.md); section 2.4 there is how a push is made from the box. In the cold test an agent that had never seen the cloud put a new app like this on the air in 113 s and 141 s ([`first-run.md`](first-run.md#cold-agent-run)); a recording of the same kind of request is in [`demo/`](demo/).

## Clean up

```bash
limactl delete -f occ
```

## What this does not show yet

- **macOS natively.** The cloud runs on Linux; on a Mac it runs in a VM, as above.
- **Reaching it from other computers.** `private` ingress (Tailscale) is tested end to end: every app at `https://<slug>.<domain>` on the tailnet only, with the installation's own CA and split DNS; it needs a Tailscale auth key and one DNS setting in the Tailscale admin console ([`install-design.md`](install-design.md#private-ingress-private--internal--tailscale)). `public` (Cloudflare tunnel or DNS) exists in the installer and is not tested end to end. `local`, used here, answers on the box (and on the Mac through Lima's forward).
- **The portal.** A placeholder answers today; the read-only portal with inventory, deploy runs, health and backups is next ([`../README.md`](../README.md#roadmap)).
- Mail (Authentik and Gitea are installed with SMTP off), MFA and replacing the bootstrap password are yours: [`first-run.md`](first-run.md#human).
