#!/usr/bin/env node
// harness-ro: the reference agent's read-only view of the box (docs/operator-contract.md).
// Runs inside the agent container with Node only; every call is a GET.
//
//   harness-ro ps                       containers: project, service, state, health, image
//   harness-ro logs NAME [LINES]        last lines of a container (name, id or Compose service)
//   harness-ro inspect NAME             container inspect (Env as names only)
//   harness-ro df                       Docker disk usage: images, build cache, volumes
//   harness-ro http URL [HOST]          status, redirect and first bytes; HOST sets the Host header
//   harness-ro gitea PATH               GET on the Gitea API with the read-only token
//   harness-ro backup                   the backup status file
//   harness-ro docker PATH              any allowlisted GET on the read-only Docker API
//
// Environment: HARNESS_DOCKER_API (http://agent-docker-proxy:2375), HARNESS_GITEA_URL,
// GITEA_READONLY_TOKEN, HARNESS_BACKUP_REPORTS (/harness/backup-reports).
import { readFileSync } from "node:fs";

const DOCKER = process.env.HARNESS_DOCKER_API || "http://agent-docker-proxy:2375";
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

const gib = (b) => (b / 1073741824).toFixed(2) + " GiB";

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
    const base = process.env.HARNESS_GITEA_URL || "http://gitea:3000";
    const r = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `token ${process.env.GITEA_READONLY_TOKEN || ""}` } });
    console.log(r.status);
    console.log(JSON.stringify(await r.json().catch(() => null), null, 2));
  },
  async backup() {
    const dir = process.env.HARNESS_BACKUP_REPORTS || "/harness/backup-reports";
    console.log(readFileSync(`${dir}/latest-status.json`, "utf8"));
  },
  async docker(path) {
    process.stdout.write((await dget(path)).toString() + "\n");
  },
};

if (!commands[cmd]) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(1, 13).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd ? 1 : 0);
}
commands[cmd](...args).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
