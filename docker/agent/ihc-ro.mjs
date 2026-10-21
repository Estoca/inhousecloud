#!/usr/bin/env node
// ihc-ro: the reference agent's read-only view of the box (docs/operator-contract.md).
// Runs inside the agent container with Node only; every call is a GET.
//
//   ihc-ro ps                       containers: project, service, state, health, image
//   ihc-ro logs NAME [LINES]        last lines of a container (name, id or Compose service)
//   ihc-ro inspect NAME             container inspect (Env as names only)
//   ihc-ro df                       Docker disk usage: images, build cache, volumes
//   ihc-ro http URL [HOST]          status, redirect and first bytes; HOST sets the Host header
//   ihc-ro gitea PATH               GET on the Gitea API with the read-only token
//   ihc-ro backup                   the backup status file
//   ihc-ro doctor [--json]          is it on the air: live checks from here + the last full run
//   ihc-ro docker PATH              any allowlisted GET on the read-only Docker API
//   ihc-ro writes                   whether ops.agent.allow_write is on, and what it allows
//   ihc-ro restart NAME             restart one app container (allow_write; never a core one)
//   ihc-ro prune-build-cache        prune the Docker build cache (allow_write)
//
// Environment: IHC_DOCKER_API (http://agent-docker-proxy:2375: docker-ro, by its alias on the agent network), IHC_GITEA_URL,
// GITEA_READONLY_TOKEN, IHC_BACKUP_REPORTS (/ihc/backup-reports),
// IHC_AGENT_ALLOW_WRITE (true|false). The proxy enforces the writes, not this script.
import { readFileSync } from "node:fs";

const DOCKER = process.env.IHC_DOCKER_API || "http://agent-docker-proxy:2375";
const [cmd, ...args] = process.argv.slice(2);

async function dget(path) {
  const r = await fetch(DOCKER + path);
  const body = Buffer.from(await r.arrayBuffer());
  if (r.status >= 300) throw new Error(`GET ${path}: ${r.status} ${body.toString().slice(0, 300)}`);
  return body;
}
const djson = async (p) => JSON.parse((await dget(p)).toString());

async function resolve(name) {
  const all = await djson("/containers/json?all=1");
  const hit = all.find((c) => c.Id.startsWith(name) || c.Names.some((n) => n === "/" + name)) ||
    all.find((c) => c.Labels["com.docker.compose.service"] === name) ||
    all.find((c) => c.Names.some((n) => n.includes(name)));
  if (!hit) throw new Error(`no container matches ${name}`);
  return hit;
}

// Docker multiplexes stdout and stderr in 8-byte framed chunks when there is no TTY.
function demux(buf) {
  if (buf.length < 8 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0 || buf[0] > 2) return buf.toString();
  let out = "", i = 0;
  while (i + 8 <= buf.length) {
    const n = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + n).toString();
    i += 8 + n;
  }
  return out;
}

const WRITES = (process.env.IHC_AGENT_ALLOW_WRITE || "false") === "true";
async function dpost(path) {
  const r = await fetch(DOCKER + path, { method: "POST" });
  const body = (await r.text()).slice(0, 300);
  return { status: r.status, body };
}

const gib = (b) => (b / 1073741824).toFixed(2) + " GiB";
const REF = new URL("..", import.meta.url).pathname; // reference/ (this file is reference/bin/ihc-ro)
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const ago = (s) => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} days`;

// One request through the proxy by name, the way a browser reaches it: http://proxy with the
// Host header; with TLS internal, https://proxy with the name as SNI. The cloud's CA is not
// in this container, so the certificate is not verified here: the host's doctor verifies it.
async function viaProxy(host, path, tls) {
  const mod = await import(tls ? "node:https" : "node:http");
  return new Promise((done) => {
    const req = mod.request({ host: "proxy", port: tls ? 443 : 80, path, method: "GET", servername: host,
      rejectUnauthorized: false, headers: { Host: host }, timeout: 10000 }, (r) => {
      let body = "";
      r.on("data", (c) => { if (body.length < 4000) body += c; });
      r.on("end", () => done({ code: r.statusCode, loc: r.headers.location || "", body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => done({ code: 0, loc: "", body: e.message }));
    req.end();
  });
}
const toSso = (r, authHost) => r.code === 302 && (r.loc.includes("outpost.goauthentik.io") || r.loc.includes(authHost));

const commands = {
  async ps() {
    const all = await djson("/containers/json?all=1");
    for (const c of all.sort((a, b) => a.Names[0].localeCompare(b.Names[0]))) {
      const l = c.Labels;
      console.log([c.Names[0].slice(1), l["com.docker.compose.project"] || "-", l["com.docker.compose.service"] || "-", c.State, c.Status, c.Image].join("\t"));
    }
  },
  async logs(name, lines = "100") {
    const c = await resolve(name);
    process.stdout.write(demux(await dget(`/containers/${c.Id}/logs?stdout=1&stderr=1&timestamps=1&tail=${Number(lines) || 100}`)));
  },
  async inspect(name) {
    const c = await resolve(name);
    console.log(JSON.stringify(await djson(`/containers/${c.Id}/json`), null, 2));
  },
  async df() {
    const d = await djson("/system/df");
    const imgs = d.Images || [], cache = d.BuildCache || [], vols = d.Volumes || [];
    const used = new Set((d.Containers || []).map((c) => c.ImageID));
    const dangling = imgs.filter((i) => !i.RepoTags || i.RepoTags.length === 0 || i.RepoTags[0] === "<none>:<none>");
    const unused = imgs.filter((i) => !used.has(i.Id));
    console.log(`images: ${imgs.length}, ${gib(imgs.reduce((s, i) => s + i.Size, 0))}; untagged ${dangling.length}; not used by any container ${unused.length} (${gib(unused.reduce((s, i) => s + i.Size, 0))})`);
    console.log(`build cache: ${cache.length} entries, ${gib(cache.reduce((s, c) => s + c.Size, 0))} (${gib(cache.filter((c) => !c.InUse).reduce((s, c) => s + c.Size, 0))} not in use)`);
    console.log(`volumes: ${vols.length}, ${gib(vols.reduce((s, v) => s + Math.max(0, (v.UsageData || {}).Size || 0), 0))}`);
    for (const i of unused) console.log(`  image not used: ${(i.RepoTags || ["<none>"])[0]} ${gib(i.Size)} ${i.Id.slice(7, 19)}`);
  },
  // node:http, not fetch: fetch drops a custom Host header, and the Host is the point.
  async http(url, host) {
    const u = new URL(url);
    const mod = await import(u.protocol === "https:" ? "node:https" : "node:http");
    await new Promise((done, fail) => {
      const req = mod.request(u, { method: "GET", headers: host ? { Host: host } : {}, timeout: 15000 }, (r) => {
        let body = "";
        r.on("data", (c) => { if (body.length < 300) body += c; });
        r.on("end", () => { console.log(`${r.statusCode} ${r.headers.location || ""}\n${body.slice(0, 300).replace(/\s+/g, " ")}`); done(); });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", fail);
      req.end();
    });
  },
  async gitea(path) {
    const base = process.env.IHC_GITEA_URL || "http://gitea:3000";
    const r = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `token ${process.env.GITEA_READONLY_TOKEN || ""}` } });
    console.log(r.status);
    console.log(JSON.stringify(await r.json().catch(() => null), null, 2));
  },
  async backup() {
    const dir = process.env.IHC_BACKUP_REPORTS || "/ihc/backup-reports";
    console.log(readFileSync(`${dir}/latest-status.json`, "utf8"));
  },
  // The agent's doctor (docs/operator-contract.md section 3). The full one (scripts/ihc-doctor.sh)
  // runs on the host: it needs .env, the proxy's admin API and Docker exec, which this
  // container never gets. Here: the checks that a read-only view allows, live, with the same
  // names and shape, plus the last full run the host wrote to reference/doctor.json.
  async doctor(flag) {
    const brief = readJson(REF + "brief.json") || {};
    const base = process.env.IHC_BASE_DOMAIN || (brief.endpoints || {}).base_domain || "";
    const tls = ((brief.endpoints || {}).ingress || "").split("/")[1] === "internal";
    const project = (brief.compose || {}).project || "ihc";
    const host = (u, d) => { try { return new URL(u).hostname; } catch { return d; } };
    const portal = host((brief.endpoints || {}).portal, `portal.${base}`), auth = host((brief.endpoints || {}).authentik, `auth.${base}`);
    const fixHost = `ask a human to run on the box: ${brief.install_dir || "<install-dir>"}/ihc doctor`;
    const checks = [];
    const add = (name, status, detail, action = "", runbook = "", evidence = []) =>
      checks.push({ name, status, detail, ...(status === "ok" ? {} : { action, runbook: runbook ? `reference/runbooks/${runbook}.md` : "" }), evidence });
    const all = await djson("/containers/json?all=1");
    const of = (proj, svc) => all.find((c) => c.Labels["com.docker.compose.project"] === proj && c.Labels["com.docker.compose.service"] === svc && c.Labels["com.docker.compose.oneoff"] !== "True");
    // containers
    const svcs = (brief.services || []).map((s) => s.service);
    const bad = [], ev = [];
    for (const s of svcs) {
      const c = of(project, s);
      ev.push(`${s}: ${c ? `${c.State} (${c.Status})` : "no container"}`);
      if (!c || c.State !== "running" || /unhealthy/.test(c.Status)) bad.push(`${s} (${c ? c.State + (/unhealthy/.test(c.Status) ? ", unhealthy" : "") : "no container"})`);
    }
    if (!svcs.length) add("containers", "warn", "reference/brief.json lists no services: nothing to compare against", fixHost, "", ev);
    else if (bad.length) add("containers", "fail", `${bad.length} of ${svcs.length} services not working: ${bad.join(", ")}`, `read its log (ihc-ro logs ${bad[0].split(" ")[0]} 50), then give the human the restart from the runbook (a core restart is level 3)`, "restart-service", ev);
    else add("containers", "ok", `all ${svcs.length} services of ${project} running and not unhealthy`, "", "", ev);
    // login
    const live = await viaProxy(auth, "/-/health/ready/", tls), root = await viaProxy(portal, "/", tls);
    const lev = [`${auth}/-/health/ready/ -> ${live.code}`, `anonymous ${portal}/ -> ${root.code} ${root.loc.slice(0, 100)}`];
    if (live.code !== 200) add("login", "fail", `the sign-in (Authentik) does not answer: ready ${live.code}`, "ihc-ro logs authentik-server 80; then the human, with runbooks/restart-service.md", "restart-service", lev);
    else if (!toSso(root, auth)) add("login", "fail", `the portal does not send an anonymous visitor to the sign-in (got ${root.code})`, "runbooks/route-and-provider.md, read mode; the fix is level 3", "route-and-provider", lev);
    else add("login", "ok", "Authentik ready; the portal sends anonymous visitors to the sign-in", "", "", lev);
    // gitea
    try {
      const r = await fetch(`${process.env.IHC_GITEA_URL || "http://gitea:3000"}/api/v1/version`, { headers: { Authorization: `token ${process.env.GITEA_READONLY_TOKEN || ""}` } });
      const v = r.status === 200 ? (await r.json()).version : "";
      v ? add("gitea", "ok", `Gitea ${v} answers`) : add("gitea", "fail", `Gitea answers ${r.status}`, "ihc-ro logs gitea 80", "restart-service");
    } catch (e) { add("gitea", "fail", `Gitea does not answer (${e.message})`, "ihc-ro logs gitea 80", "restart-service"); }
    // backup
    const dir = process.env.IHC_BACKUP_REPORTS || "/ihc/backup-reports";
    const st = readJson(`${dir}/latest-status.json`), okf = readJson(`${dir}/latest-success.json`);
    if (st || okf) {
      const maxH = Number((st || {}).max_age_hours || 26);
      const age = okf ? (Date.now() - Date.parse(okf.finished_at)) / 1000 : null;
      const side = of(project, "backup");
      const bev = [`latest run ${(st || {}).run_id} ${(st || {}).status}`, `backup container: ${side ? side.State : "none"}`];
      if (!side || side.State !== "running") add("backup", "fail", "the backup container is not running: no backup will run on schedule", "give the human the start from runbooks/backup-stuck.md", "backup-stuck", bev);
      else if (age === null) add("backup", "fail", "no backup has ever succeeded", "runbooks/backup-stuck.md", "backup-stuck", bev);
      else if (age / 3600 > maxH) add("backup", "fail", `the newest good backup is ${ago(age)} old, older than the ${maxH} h window`, "runbooks/backup-stuck.md (read mode), then the human runs the backup", "backup-stuck", bev);
      else add("backup", "ok", `newest good backup ${ago(age)} old (window ${maxH} h); repository not verified from here`, "", "", bev);
    }
    // apps
    for (const a of brief.apps || []) {
      if (a.kind === "system-test") continue;
      const hc = a.health_check || {}, svc = hc.service || "app", path = hc.health_path || "/health", want = Number(hc.health_status || 200);
      const name = `${a.slug}.${base}`, c = of(a.slug, svc);
      const aev = [`expects ${path} = ${want} on ${name}`, `${a.slug} ${svc}: ${c ? `${c.State} (${c.Status})` : "no container"}`];
      if (!c || c.State !== "running") { add(`app:${a.slug}`, "fail", `${a.slug} is down: its container is ${c ? c.State : "missing"}`, `ihc-ro writes, then runbooks/restart-service.md (an app restart is level 2: only on an explicit instruction)`, "diagnose-app-down", aev); continue; }
      const h = await viaProxy(name, path, tls);
      aev.push(`${name}${path} -> ${h.code}`);
      if (h.code !== want) { add(`app:${a.slug}`, "fail", `${a.slug} answers ${h.code} on ${path} through the proxy (wants ${want})`, `ihc-ro logs ${c.Names[0].slice(1)} 50; runbooks/diagnose-app-down.md`, "diagnose-app-down", aev); continue; }
      if (hc.auth_required !== false) {
        const r = await viaProxy(name, "/", tls);
        aev.push(`anonymous ${name}/ -> ${r.code}`);
        if (!toSso(r, auth)) { add(`app:${a.slug}`, "fail", `${a.slug} is up but not behind the sign-in (anonymous / got ${r.code})`, "runbooks/route-and-provider.md; re-running the deploy restores it", "route-and-provider", aev); continue; }
      }
      add(`app:${a.slug}`, "ok", `${a.slug} up: ${path} = ${h.code} through the proxy`, "", "", aev);
    }
    // the last full run, from the host
    const host_report = readJson(REF + "doctor.json");
    if (!host_report) add("host-report", "warn", "no full doctor run from the host yet (reference/doctor.json)", fixHost);
    else {
      const age = (Date.now() - Date.parse(host_report.generated_at)) / 1000;
      const notOk = (host_report.checks || []).filter((c) => c.status !== "ok");
      const line = `the host's full run ${ago(age)} ago: ${host_report.summary.ok} ok, ${host_report.summary.warn} warn, ${host_report.summary.fail} fail`;
      const hev = notOk.map((c) => `${c.name} ${c.status}: ${c.detail} -> ${c.action}`);
      if (age > 86400) add("host-report", "warn", `${line}; older than a day`, fixHost, "", hev);
      else if (notOk.length) add("host-report", host_report.summary.fail ? "fail" : "warn", `${line}: ${notOk.map((c) => c.name).join(", ")}`, "follow each check's action (evidence lines); the host-only ones (disk, TLS, DNS, runners, Postgres, Redis, the backup repository) are not re-checked here", "", hev);
      else add("host-report", "ok", line);
    }
    const summary = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) summary[c.status] += 1;
    const report = { doctor_version: 1, source: "agent", generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), checks, summary,
      not_checked_here: ["install", "docker", "disk", "memory", "routes", "dns", "tls", "runners", "postgres", "redis", "backup repository", "agent", "version"] };
    if (flag === "--json") console.log(JSON.stringify(report, null, 2));
    else {
      const mark = { ok: "[ok]", warn: "[!!]", fail: "[xx]" };
      for (const c of checks) {
        console.log(`${mark[c.status]} ${c.name}: ${c.detail}`);
        if (c.status !== "ok") console.log(`     do: ${c.action}${c.runbook ? ` (${c.runbook})` : ""}`);
      }
      console.log(`${summary.fail} fail, ${summary.warn} warn, ${summary.ok} ok (live from the agent; host-only checks come from the last full run)`);
    }
    if (summary.fail) process.exit(1);
  },
  async docker(path) {
    process.stdout.write((await dget(path)).toString() + "\n");
  },
  async writes() {
    console.log(WRITES
      ? "allow_write: on. Allowed: restart of one app container (ihc-ro restart NAME) and build cache prune (ihc-ro prune-build-cache). Never a core container, never anything else."
      : "allow_write: off. Every Docker write is refused; give the human the command instead.");
  },
  // Level 2 of the contract: only on an explicit instruction naming the app. Record the
  // state before (ihc-ro inspect) and prove health after (runbooks/restart-service.md).
  async restart(name) {
    if (!name) throw new Error("usage: ihc-ro restart NAME");
    const c = await resolve(name);
    const project = c.Labels["com.docker.compose.project"] || "-";
    const before = `${c.Names[0].slice(1)} project=${project} state=${c.State} (${c.Status})`;
    const r = await dpost(`/containers/${c.Id}/restart?t=10`);
    console.log(`before: ${before}`);
    console.log(r.status === 204 ? "restart: 204 accepted" : `restart: ${r.status} ${r.body}`);
    if (r.status !== 204) process.exit(1);
    const after = (await djson("/containers/json?all=1")).find((x) => x.Id === c.Id);
    console.log(`after: state=${after ? after.State : "?"} (${after ? after.Status : "?"}); now prove health along the chain`);
  },
  async "prune-build-cache"() {
    const r = await dpost("/build/prune");
    console.log(r.status === 200 ? `build cache pruned: ${r.body}` : `prune: ${r.status} ${r.body}`);
    if (r.status !== 200) process.exit(1);
  },
};

if (!commands[cmd]) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(1, 17).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd ? 1 : 0);
}
commands[cmd](...args).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
