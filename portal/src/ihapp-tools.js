import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { readPlatformConfig } from './config.js';
import { validateManifest, validAppSlug } from './validate-manifest.js';
import { createGiteaState } from './gitea-state.js';
import { createPlatformTools } from './mcp-platform-tools.js';
import { readDeployJournal, deployJournalDir } from './deploy-journal.js';
import { createIhappStore, TTL, terminal, digest } from './ihapp-store.js';
import { createIhappGit } from './ihapp-git.js';
import { createIhappLinks } from './ihapp-links.js';
import { INPUTS, validateInput } from './ihapp-input.js';
import { LIMITS, IhappError, inlineFiles, checkPath, checkTree, readTree, runFile } from './ihapp-files.js';
import { RULES, finding, bounded, secretMatches, STATIC_STAGES, SKIPPED_STAGES } from './ihapp-rules.js';

export function ihappConfigFromEnv(env = process.env) {
  const platform = readPlatformConfig(env);
  const checks = Number(env.IHC_CHAT_CHECKS_PER_HOUR);
  return { token: String(env.IHC_CHAT_GITEA_TOKEN || '').trim(), gitUser: env.IHC_CHAT_GITEA_USER || 'ihc-chat',
    giteaUrl: platform.giteaUrl || 'http://gitea:3000', org: platform.giteaOrg, baseDomain: platform.baseDomain,
    publicUrl: (env.MCP_PUBLIC_URL || `${platform.scheme}://mcp.${platform.baseDomain}`).replace(/\/+$/, ''),
    dir: env.IHC_CHAT_DIR || '/ihc/chat', newAppGroup: env.IHC_CHAT_NEW_APP_GROUP || 'ihc-admins', userGroup: platform.userGroup,
    checksPerHour: Number.isInteger(checks) && checks > 0 ? checks : 30, applint: env.IHC_APPLINT || '/app/applint/applint.py',
    installDir: env.IHC_INSTALL_DIR || '/opt/inhousecloud', templateDir: env.IHC_TEMPLATE_DIR || '/app/templates/app' };
}
const DESCRIPTIONS = {
  ihapp_spec: 'The In House Apps v1 contract, rules, static stages, starter tree and signed source/upload links. Available when the deploy account is configured.',
  ihapp_check: 'Checks a candidate with manifest validation, static trust-boundary lint and secrets scan. No candidate code is built or executed. Poll ihapp_deploy_status; no approval required.',
  ihapp_deploy: 'Writes the passed candidate as a commit on main and starts the usual Actions deploy. Show the exact change and obtain human approval first; pass confirmed_by. Both people need permission.',
  ihapp_deploy_status: 'Poll a check or deploy by job_id, or the latest visible job for a slug. Returns deterministic findings, stages, summary and polling interval.',
};
export const IHAPP_TOOLS = Object.entries(INPUTS).map(([name, inputSchema]) => ({ name, inputSchema, description: DESCRIPTIONS[name], annotations: { readOnlyHint: name !== 'ihapp_deploy', destructiveHint: false, openWorldHint: false } }));
export const isIhappTool = name => Object.hasOwn(INPUTS, name);
export const PROVIDED_ENV = [
  ['PORT', 'Internal HTTP listening port'], ['APP_SLUG', 'App slug'], ['APP_BASE_URL', 'Public app address'], ['DATA_DIR', 'Persistent app data at /data'],
  ...['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].map(n => [n, 'Shared Postgres, isolated app database and role', 'database.required']),
  ...['REDIS_URL', 'REDIS_PREFIX'].map(n => [n, 'Shared Redis, isolated ACL and key prefix', 'dependencies.redis.required']),
  ...['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'S3_FORCE_PATH_STYLE'].map(n => [n, 'Shared object storage, isolated app bucket', 'object_storage.required']),
  ...['IHC_MCP_ISSUER', 'IHC_MCP_JWKS_URL', 'IHC_MCP_AUDIENCE'].map(n => [n, 'Actor JWT validation']),
  ...['IHC_SECRETS_PROXY_URL', 'IHC_SECRETS_PROXY_TOKEN'].map(n => [n, 'App identity for the credential proxy; never the upstream credential', 'secrets_proxy with the agent profile']),
].map(([name, meaning, when = 'always']) => ({ name, meaning, when }));

export function createIhappTools({ env = process.env, config = ihappConfigFromEnv(env), directory, audit, now = Date.now, fetchFn = fetch,
  remoteUrl, listAppsFn, listHttpHealthFn, lintTimeoutMs = 12_000 } = {}) {
  const configured = Boolean(config.token);
  let state;
  const activeChecks = new Set();
  function resources() {
    if (!state) {
      const store = createIhappStore({ dir: config.dir, now });
      const git = createIhappGit({ config, store, remoteUrl });
      state = { store, git, links: createIhappLinks({ store, config, git }) };
    }
    return state;
  }
  const visible = user => configured && Array.isArray(user.groups) && user.groups.includes(config.userGroup);
  const toolsFor = user => visible(user) ? IHAPP_TOOLS : [];
  const apiBase = slug => `/repos/${encodeURIComponent(config.org)}/${encodeURIComponent(slug)}`;
  async function api(route, { method = 'GET', body, allow404 = false, allow403 = false } = {}) {
    const response = await fetchFn(`${config.giteaUrl}/api/v1${route}`, { method, headers: { Authorization: `token ${config.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (response.status === 404 && allow404) return null;
    if (response.status === 403 && allow403) return null;
    if (!response.ok) throw new IhappError('IHC-DEPLOY-FAILED', `Gitea answered HTTP ${response.status}.`);
    return response.status === 204 ? {} : response.json();
  }
  const accepted = job => ({ job_id: job.job_id, kind: job.kind, state: terminal(job.state) && job.state !== 'refused' ? 'running' : job.state, ...(job.candidate_id ? { candidate_id: job.candidate_id } : {}), ...(job.commit ? { commit: job.commit } : {}), poll_after_seconds: 2, ...(job.state === 'refused' ? { findings: job.findings } : {}) });
  function finish(job, stateName, findings, summary) {
    Object.assign(job, { state: stateName, ...bounded(findings), summary, terminal: terminal(stateName) });
    if (terminal(stateName)) job.finished_at = new Date(now()).toISOString();
    return resources().store.save(job);
  }
  function refuse(job, code, message) { return accepted(finish(job, 'refused', [finding(code, message)], message.slice(0, 300))); }
  function fill(text, slug, user) {
    const replacements = { __APP_SLUG__: slug, __APP_NAME__: slug, __OWNER_EMAIL__: user.email, __APP_DOMAIN__: `${slug}.${config.baseDomain}`, __APP_GROUP__: config.userGroup };
    for (const [key, value] of Object.entries(replacements)) text = text.split(key).join(value);
    return text;
  }
  async function spec(user, input) {
    const { store, git, links } = resources(); store.prune();
    const slug = input.slug || 'sample-app';
    const template = readTree(config.templateDir);
    const example = fill(template.get('company-app.yaml').toString(), slug, user);
    const starterImage = template.get('Dockerfile')?.toString().match(/^FROM\s+(\S+)/mi)?.[1];
    if (!starterImage) throw new IhappError('IHC-MANIFEST-INVALID', 'The installed starter has no Dockerfile base image.');
    const out = { spec_version: '1', stack: { runtime: 'docker-compose', starters: [{ id: 'node', image: starterImage, description: 'The installed Node starter; apps may use other container stacks.' }] },
      manifest: { schema_url: 'schemas/company-app.schema.json', schema: JSON.parse(readFileSync(new URL('./ihapp-manifest-schema.json', import.meta.url))), example },
      env: { provided: PROVIDED_ENV }, auth: { person_header: 'X-authentik-email', notes: 'Trust only the platform proxy; require company sign-in.' },
      rules: RULES.map(([code, , text]) => ({ code, text })), limits: { ...LIMITS, checks_per_hour: config.checksPerHour },
      check_stages: [...STATIC_STAGES, ...SKIPPED_STAGES.map(s => s.stage)],
      check_stage_states: [...STATIC_STAGES.map(stage => ({ stage, state: 'pending' })), ...SKIPPED_STAGES],
      deploy_policy: { existing_app: 'same as push to main in Gitea', new_app_group: config.newAppGroup } };
    if (input.include?.includes('template')) out.template = { files: [...template].map(([p, b]) => ({ path: p, content: fill(b.toString(), slug, user), encoding: 'utf8' })) };
    if (input.slug) {
      const repo = await api(apiBase(slug), { allow404: true });
      out.app = { slug, exists: Boolean(repo && !repo.empty) };
      if (out.app.exists) {
        const head = await git.head(slug);
        if (!head) throw new IhappError('IHC-DEPLOY-FAILED', 'The repository has no main branch.');
        const files = await git.tree(slug, head);
        Object.assign(out.app, { head_commit: head, files: [...files].map(([p, b]) => ({ path: p, size: b.length, sha256: digest(b) })) });
        if (input.include?.includes('source')) out.app.source = links.issue('source', user.email, { slug, commit: head });
      }
    }
    if (input.include?.includes('upload')) out.upload = links.issue('upload', user.email);
    return out;
  }
  async function runCheck(job, files) {
    const { store } = resources();
    const findings = [], values = [];
    const secrets = [];
    // Scan before processing diagnostics so even an echoed YAML secret is redacted.
    for (const [p, b] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const text = b.toString('utf8');
      for (const m of secretMatches(text, { example: /(?:^|\/)(?:\.env\.example|[^/]*example[^/]*)$/i.test(p) })) {
        values.push(m.value);
        secrets.push(finding('IHC-SECRETS-IN-TREE', 'Credential-shaped value [redacted] is committed in the tree.', { file: p, line: text.slice(0, m.index).split('\n').length }));
      }
    }
    for (const stage of STATIC_STAGES) {
      const start = now(), before = findings.length;
      job.stages.push({ stage, state: 'running' }); store.save(job);
      try {
        if (stage === 'manifest') {
          let manifest, document;
          const lineCounter = new YAML.LineCounter();
          try {
            document = YAML.parseDocument(files.get('company-app.yaml')?.toString() || '', { lineCounter });
            if (document.errors.length) throw new Error('Invalid YAML');
            manifest = document.toJS({ maxAliasCount: 100 });
          } catch { findings.push(finding('IHC-MANIFEST-INVALID', 'company-app.yaml is not valid YAML.', { file: 'company-app.yaml', ...(document?.errors[0]?.linePos?.[0]?.line ? { line: document.errors[0].linePos[0].line } : {}) })); }
          if (manifest !== undefined) {
            const result = validateManifest(manifest, { staticApp: true });
            const location = key => {
              const node = document?.getIn(key.split('.'), true);
              return { file: 'company-app.yaml', ...(node?.range ? { line: lineCounter.linePos(node.range[0]).line } : {}) };
            };
            for (const issue of result.issues) findings.push(finding(issue.path === 'app.slug' ? 'IHC-MANIFEST-SLUG' : 'IHC-MANIFEST-INVALID', `${issue.path}: ${issue.message}`, location(issue.path), values));
            if (manifest?.app?.slug !== job.slug) findings.push(finding('IHC-MANIFEST-SLUG', 'The manifest slug must equal the requested slug.', location('app.slug')));
          }
        } else if (stage === 'lint') {
          let result;
          try {
            result = await runFile('python3', [config.applint, store.treePath(job.candidate_id), config.installDir], { timeout: lintTimeoutMs, maxBuffer: 512 * 1024, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' } });
          } catch (error) {
            result = error;
            if (error.killed || error.signal || typeof error.code !== 'number' || error.code !== 1 || !(error.stdout || '').trim()) findings.push(finding('IHC-LINT-FAILED', 'The static linter crashed, timed out, or was unavailable; the stage did not pass.'));
          }
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
          for (let line of output.split(/\r?\n/).filter(Boolean)) {
            line = line.split(store.treePath(job.candidate_id) + '/').join('');
            const place = line.match(/^([^:]+):(?:(\d+):)?\s*(.*)$/);
            const file = place && files.has(place[1]) ? place[1] : undefined;
            const code = RULES.find(r => r[3]?.test(line))?.[0] || 'IHC-LINT-OTHER';
            findings.push(finding(code, place && file ? place[3] : line, { ...(file ? { file } : {}), ...(file && place[2] ? { line: Number(place[2]) } : {}) }, values));
          }
        } else findings.push(...secrets);
      } catch { findings.push(finding(stage === 'lint' ? 'IHC-LINT-FAILED' : 'IHC-MANIFEST-INVALID', `The ${stage} stage could not complete.`)); }
      Object.assign(job.stages.at(-1), { state: findings.length > before ? 'failed' : 'passed', seconds: Math.max(0, (now() - start) / 1000) });
    }
    job.stages.push(...SKIPPED_STAGES);
    finish(job, findings.some(f => f.severity === 'error') ? 'failed' : 'passed', findings, findings.length ? 'The static check found problems; fix the findings and check again.' : 'The static check passed; runtime stages run in the deploy job.');
  }
  async function check(user, input) {
    const { store, git, links } = resources(); store.prune();
    const job = store.create('check', input.slug, user.email); job.base_commit = input.base_commit;
    const recent = store.jobs().filter(j => j.kind === 'check' && j.person === user.email && j.job_id !== job.job_id && now() - Date.parse(j.created_at) < 3600_000 && j.findings?.[0]?.code !== 'IHC-CHECK-LIMIT');
    if (activeChecks.has(user.email) || recent.some(j => !terminal(j.state))) return refuse(job, 'IHC-CHECK-LIMIT', 'One check is already running for this person; wait for it to finish.');
    if (recent.length >= config.checksPerHour) return refuse(job, 'IHC-CHECK-LIMIT', 'The hourly check limit has been reached; try again after the oldest check is one hour old.');
    activeChecks.add(user.email);
    try {
      const incoming = input.files ? inlineFiles(input.files) : await links.consume(input.upload_id, user.email);
      const files = input.tree === 'changes' ? await git.tree(input.slug, input.base_commit) : new Map();
      for (const p of input.delete ?? []) { checkPath(p); files.delete(p); }
      for (const [p, b] of incoming) files.set(p, b);
      checkTree(files);
      job.candidate_id = store.put(files); job.candidate_expires_at = new Date(now() + TTL).toISOString();
      job.state = 'running'; store.save(job);
      // The call always returns JobAccepted; status holds the eventual static result.
      setImmediate(() => runCheck(job, files).catch(() => finish(job, 'failed', [finding('IHC-LINT-FAILED', 'The static check could not complete.')], 'The static check failed; check again.')).finally(() => activeChecks.delete(user.email)));
      return accepted(job);
    } catch (error) {
      activeChecks.delete(user.email);
      return refuse(job, error instanceof IhappError ? error.code : 'IHC-FILES-PATH', error instanceof IhappError ? error.message : 'The candidate could not be materialized; verify the base commit and files.');
    }
  }
  async function allowed(person, slug, isNew) {
    if (!person || !/^[^\s@]+@[^\s@]+$/.test(person.email ?? '') || person.is_active === false || !Array.isArray(person.groups) || !person.groups.includes(config.userGroup)) return false;
    if (isNew) return (person.groups ?? []).includes(config.newAppGroup);
    if (!person.username) return false;
    const permission = await api(`${apiBase(slug)}/collaborators/${encodeURIComponent(person.username)}/permission`, { allow404: true, allow403: true });
    return ['write', 'admin', 'owner'].includes(permission?.permission) || permission?.user?.permissions?.push === true;
  }
  async function deploy(user, input, { approver, confirmedBy } = {}) {
    const { store, git } = resources(); store.prune();
    const job = store.create('deploy', input.slug, user.email); Object.assign(job, { candidate_id: input.candidate_id, base_commit: input.base_commit });
    const outcome = result => {
      const previous = Object.hasOwn(job, 'previous') ? job.previous : input.base_commit;
      return { result, audit: { previous, new: job.commit ?? previous, target: `${config.org}/${input.slug}`, status: job.state === 'refused' ? job.findings[0].code : 'ok' } };
    };
    const passed = store.jobs().find(j => j.kind === 'check' && j.slug === input.slug && j.candidate_id === input.candidate_id && j.base_commit === input.base_commit && j.state === 'passed' && now() - Date.parse(j.created_at) < TTL);
    if (!passed || !store.treePath(input.candidate_id) || !existsSync(store.treePath(input.candidate_id))) return outcome(refuse(job, 'IHC-DEPLOY-CANDIDATE-EXPIRED', 'The candidate is unknown, failed, expired, or checked for another slug or base.'));
    try {
      const people = await directory.listUsers();
      const caller = people.find(p => p.email?.toLowerCase() === user.email?.toLowerCase());
      const confirmer = people.find(p => p.email?.toLowerCase() === (approver?.email || confirmedBy)?.toLowerCase());
      if (!await allowed(caller, input.slug, input.base_commit === null) || !await allowed(confirmer, input.slug, input.base_commit === null)) return outcome(refuse(job, 'IHC-DEPLOY-NOT-ALLOWED', 'Both caller and approver must be active company members with permission. Sign in to Gitea once and ask an admin to add you to the ihc-users team; new apps require the new-app group.'));
      const repo = await api(apiBase(input.slug), { allow404: true });
      if (input.base_commit === null) {
        if (repo && !repo.empty) {
          job.previous = await git.head(input.slug);
          return outcome(refuse(job, 'IHC-DEPLOY-STALE-BASE', 'This repository already has commits; read main and check again.'));
        }
      } else {
        job.previous = repo ? await git.head(input.slug) : null;
        if (job.previous !== input.base_commit) return outcome(refuse(job, 'IHC-DEPLOY-STALE-BASE', 'main moved since the candidate was checked; nothing changed.'));
      }
      const files = readTree(store.treePath(input.candidate_id));
      if (input.base_commit === null && !files.has('.gitea/workflows/deploy.yml')) {
        files.set('.gitea/workflows/deploy.yml', Buffer.from(fill(readFileSync(path.join(config.templateDir, '.gitea/workflows/deploy.yml'), 'utf8'), input.slug, user)));
        job.added_workflow = '.gitea/workflows/deploy.yml';
      }
      if (!repo) await api(`/orgs/${encodeURIComponent(config.org)}/repos`, { method: 'POST', body: { name: input.slug, private: true, auto_init: false, default_branch: 'main' } });
      if (input.base_commit === null) await api(apiBase(input.slug), { method: 'PATCH', body: { has_actions: true } });
      job.previous = input.base_commit;
      job.commit = await git.push(input.slug, input.base_commit, files, `${input.message}\n\nRequested-by: ${user.email}\nConfirmed-by: ${confirmedBy || approver.email}\nCandidate: ${input.candidate_id}\n`);
      job.stages = [{ stage: 'commit', state: 'passed' }, { stage: 'apply', state: 'pending' }];
      job.summary = 'The commit was pushed; waiting for the Actions deploy.'; store.save(job);
      return outcome(accepted(job));
    } catch (error) { return outcome(refuse(job, error instanceof IhappError ? error.code : 'IHC-DEPLOY-FAILED', error instanceof IhappError ? error.message : 'Deployment could not complete; inspect main before retrying.')); }
  }
  const actions = createGiteaState({ env: { ...env, GITEA_URL: config.giteaUrl, GITEA_TOKEN: config.token }, fetchImpl: (url, options) => fetchFn(url, { ...options, signal: AbortSignal.timeout(5000), redirect: 'manual' }), cacheTtlMs: 0, now });
  const healthTools = createPlatformTools({ env, ...(listAppsFn ? { listAppsFn } : {}), ...(listHttpHealthFn ? { listHttpHealthFn } : {}) });
  async function status(user, input) {
    const { store, git } = resources(); store.prune();
    // Only the submitting person sees a job. Slug lookup applies the same filter.
    const job = input.job_id ? store.get(input.job_id) : store.jobs().filter(j => j.slug === input.slug && j.person === user.email).sort((a, b) => b.created_at.localeCompare(a.created_at) || (b.sequence ?? 0) - (a.sequence ?? 0))[0];
    if (!job || job.person !== user.email) throw new IhappError('IHC-DEPLOY-NOT-ALLOWED', 'No job visible to this person.');
    if (job.kind === 'deploy' && !terminal(job.state)) {
      const runs = await actions.listRuns({ owner: config.org, repo: job.slug, full_name: `${config.org}/${job.slug}` }, { limit: 100 });
      const matching = runs.runs.filter(r => r.commit_sha === job.commit);
      const success = matching.find(r => r.outcome === 'success');
      const run = success || matching[0];
      if (run?.url && /^https?:\/\//.test(run.url)) job.run_log = run.url;
      if (success) {
        const apps = await healthTools.call(user, 'ihc_list_apps', { query: job.slug });
        const app = apps.apps.find(a => a.slug === job.slug);
        const healthy = app?.health.checked && app.health.ok && (app.sso.required === false || app.sso.effective === true);
        job.url = app?.url || `https://${job.slug}.${config.baseDomain}`;
        const journal = readDeployJournal(job.slug, { dir: deployJournalDir(env) });
        job.rollback_available = Boolean(journal.undo?.available || job.previous);
        job.stages = [{ stage: 'commit', state: 'passed' }, { stage: 'apply', state: 'passed' }, { stage: 'health', state: healthy ? 'passed' : 'failed' }];
        finish(job, healthy ? 'healthy' : 'unhealthy', healthy ? [] : [finding('IHC-HEALTH-STATUS', 'The app health or sign-in probe failed after a successful Actions run.')], healthy ? 'The app is healthy behind company sign-in.' : 'The deploy completed but the app health or sign-in check failed.');
      } else if (runs.available && await git.head(job.slug) !== job.commit) {
        finish(job, 'superseded', [], 'main moved past this commit and no run of it succeeded.');
      } else if (run && ['failed', 'cancelled'].includes(run.outcome)) {
        job.stages = [{ stage: 'commit', state: 'passed' }, { stage: 'apply', state: 'failed' }];
        finish(job, 'failed', [finding('IHC-BUILD-FAILED', `The Actions deploy failed${job.run_log ? `; run: ${job.run_log}` : '.'}`)], 'The Actions deploy failed; inspect the linked run.');
      } else {
        job.state = run && !['queued', 'waiting', 'pending', 'blocked'].includes(run.status) ? 'running' : 'queued';
        job.summary = runs.available ? `The Actions deploy is ${job.state}.` : 'Actions status is temporarily unavailable; poll again.';
        job.stages = [{ stage: 'commit', state: 'passed' }, { stage: 'apply', state: job.state === 'running' ? 'running' : 'pending' }];
        store.save(job);
      }
    }
    const { person, base_commit, previous, added_workflow, sequence, ...out } = job;
    return { ...out, terminal: terminal(job.state), poll_after_seconds: terminal(job.state) ? 60 : 2, ...(added_workflow ? { added_workflow } : {}) };
  }
  async function call(user, name, input, context = {}) {
    if (!visible(user)) throw new IhappError('IHC-DEPLOY-NOT-ALLOWED', 'In House Apps requires USER_GROUP membership and a configured deploy account.');
    validateInput(name, name === 'ihapp_deploy' ? { ...input, confirmed_by: context.confirmedBy || context.approver?.email || input.confirmed_by } : input);
    if (input.slug && !validAppSlug(input.slug)) throw new IhappError('IHC-MANIFEST-SLUG', 'Use a valid unreserved app slug.');
    if (name === 'ihapp_spec') return spec(user, input);
    if (name === 'ihapp_check') {
      const result = await check(user, input);
      if (audit?.configured) {
        const entry = { requestId: context.requestId || crypto.randomUUID(), actor: user, tool: name, provider: input.slug, access: 'read', arguments: { slug: input.slug, base_commit: input.base_commit, job_id: result.job_id, ...(result.candidate_id ? { candidate_id: result.candidate_id } : {}) }, status: 'check' };
        await audit.record({ ...entry, phase: 'requested' });
        await audit.record({ ...entry, phase: 'completed' });
      }
      return result;
    }
    if (name === 'ihapp_deploy') return deploy(user, input, context);
    return status(user, input);
  }
  function attachRoutes(app) {
    const route = method => async (req, res) => {
      if (!configured) return res.status(404).end();
      res.set('Cache-Control', 'no-store');
      try { await resources().links[method](req, res); }
      catch { if (!res.headersSent) res.status(503).json({ error: 'link_unavailable' }); }
    };
    app.put('/ihapp/upload/:token', route('put'));
    app.get('/ihapp/source/:token', route('get'));
  }
  return { configured, toolsFor, call, attachRoutes, resources };
}
