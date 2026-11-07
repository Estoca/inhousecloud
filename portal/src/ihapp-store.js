import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TTL = 24 * 3600_000;
export const terminal = state => !['queued', 'running'].includes(state);
export const digest = data => crypto.createHash('sha256').update(data).digest('hex');
export function candidateId(files) {
  // Length-delimited by JSON; byte content is base64, paths sort by JS code unit order.
  return `sha256:${digest(JSON.stringify([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([p, b]) => [p, b.toString('base64')])) )}`;
}
export function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}`;
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function createIhappStore({ dir, now = Date.now } = {}) {
  for (const part of ['', 'jobs', 'candidates', 'links', 'work']) mkdirSync(path.join(dir, part), { recursive: true, mode: 0o700 });
  const jobs = () => readdirSync(path.join(dir, 'jobs')).filter(f => /^job_[a-z0-9]+\.json$/.test(f)).map(f => readJson(path.join(dir, 'jobs', f)));
  let sequence = jobs().reduce((max, job) => Math.max(max, job.sequence ?? 0), 0);
  const save = job => { atomicJson(path.join(dir, 'jobs', `${job.job_id}.json`), job); return job; };
  function create(kind, slug, person) {
    return save({ job_id: `job_${crypto.randomBytes(12).toString('hex')}`, sequence: ++sequence, kind, slug, person, state: 'queued', stages: [], findings: [], summary: 'The job is queued.', created_at: new Date(now()).toISOString(), poll_after_seconds: 2 });
  }
  const get = id => /^job_[a-z0-9]{8,40}$/.test(id ?? '') ? readJson(path.join(dir, 'jobs', `${id}.json`)) : null;
  const treePath = id => /^sha256:[a-f0-9]{64}$/.test(id ?? '') ? path.join(dir, 'candidates', id.slice(7), 'tree') : null;
  function put(files) {
    const id = candidateId(files), target = path.dirname(treePath(id));
    if (!existsSync(target)) {
      const temp = mkdtempSync(path.join(dir, 'work', 'candidate-'));
      try {
        mkdirSync(path.join(temp, 'tree'));
        for (const [p, bytes] of files) { const file = path.join(temp, 'tree', p); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes, { mode: 0o600 }); }
        atomicJson(path.join(temp, 'meta.json'), { created_at: new Date(now()).toISOString() });
        renameSync(temp, target);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return id;
  }
  function prune() {
    const all = jobs(), keep = new Set(all.filter(j => (j.kind === 'deploy' && !terminal(j.state)) || now() - Date.parse(j.created_at) <= TTL).map(j => j.candidate_id));
    for (const j of all) if (terminal(j.state) && now() - Date.parse(j.created_at) > TTL) rmSync(path.join(dir, 'jobs', `${j.job_id}.json`));
    for (const name of readdirSync(path.join(dir, 'candidates'))) {
      const target = path.join(dir, 'candidates', name), meta = readJson(path.join(target, 'meta.json'));
      if (!keep.has(`sha256:${name}`) && now() - Date.parse(meta?.created_at) > TTL) rmSync(target, { recursive: true, force: true });
    }
    for (const name of readdirSync(path.join(dir, 'links')).filter(n => n.endsWith('.json'))) {
      const file = path.join(dir, 'links', name), link = readJson(file);
      if (now() > link.expires && (!link.busy || now() - link.expires > TTL)) { rmSync(file, { force: true }); rmSync(file.replace(/\.json$/, '.tar.gz'), { force: true }); }
    }
    for (const name of readdirSync(path.join(dir, 'work'))) {
      const file = path.join(dir, 'work', name);
      if (now() - statSync(file).mtimeMs > TTL) rmSync(file, { recursive: true, force: true });
    }
  }
  // Static checks cannot survive a process restart. Refuse instead of leaving a lock forever.
  for (const j of jobs()) if (j.kind === 'check' && !terminal(j.state)) save({ ...j, state: 'failed', summary: 'The gateway restarted during this check; check again.', findings: [{ code: 'IHC-LINT-FAILED', stage: 'lint', severity: 'error', message: 'The gateway restarted during this check.', fix: 'Check the candidate again.' }] });
  return { dir, now, jobs, save, create, get, put, treePath, prune, temp: () => mkdtempSync(path.join(dir, 'work', 'job-')) };
}
