import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGiteaState,
  formatRun,
  isDeployRun,
  normalizeRunStatus,
  parseGiteaRepo,
} from '../src/gitea-state.js';

const env = {
  GITEA_URL: 'http://gitea.local:3007',
  GITEA_TOKEN: 'read-only-token',
};

function tasksPayload() {
  return {
    total_count: 4,
    workflow_runs: [
      {
        id: 12,
        name: 'build-and-deploy',
        head_branch: '#44',
        head_sha: 'ffff000011112222',
        run_number: 12,
        event: 'pull_request',
        display_title: 'PR check',
        status: 'success',
        workflow_id: 'deploy.yml',
        url: 'https://git.cloud.localhost/company/chamados/actions/runs/12',
        created_at: '2026-10-15T19:22:52Z',
        updated_at: '2026-10-15T19:24:05Z',
        run_started_at: '2026-10-15T19:22:52Z',
      },
      {
        id: 11,
        name: 'build-and-deploy',
        head_branch: 'main',
        head_sha: 'bbbde842b8bf203087b125591e45d2634b532c45',
        run_number: 11,
        event: 'push',
        display_title: 'Fix login redirect',
        status: 'success',
        workflow_id: 'deploy.yml',
        url: 'https://git.cloud.localhost/company/chamados/actions/runs/11',
        created_at: '2026-10-14T17:07:09Z',
        updated_at: '2026-10-14T17:07:44Z',
        run_started_at: '2026-10-14T17:07:09Z',
      },
      {
        id: 10,
        name: 'build-and-deploy',
        head_branch: 'main',
        head_sha: '1111222233334444',
        run_number: 10,
        event: 'push',
        display_title: 'Broken build',
        status: 'failure',
        workflow_id: 'deploy.yml',
        url: 'https://git.cloud.localhost/company/chamados/actions/runs/10',
        created_at: '2026-10-08T14:08:18Z',
        updated_at: '2026-10-08T14:08:45Z',
        run_started_at: '2026-10-08T14:08:18Z',
      },
      {
        id: 9,
        name: 'build-and-deploy',
        head_branch: 'main',
        head_sha: '5555666677778888',
        run_number: 9,
        event: 'push',
        display_title: 'Still running',
        status: 'running',
        workflow_id: 'deploy.yml',
        url: 'https://git.cloud.localhost/company/chamados/actions/runs/9',
        created_at: '2026-10-16T10:00:00Z',
        updated_at: '2026-10-16T10:00:10Z',
        run_started_at: '2026-10-16T10:00:00Z',
      },
    ],
  };
}

function fakeFetch(calls, { tasks = tasksPayload(), commitStatus = 200 } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/actions/tasks')) {
      return { ok: true, status: 200, json: async () => tasks };
    }
    if (url.includes('/git/commits/')) {
      if (commitStatus !== 200) return { ok: false, status: commitStatus, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: 'bbbde842b8bf203087b125591e45d2634b532c45',
          author: { login: 'DiegoSouza' },
          commit: { author: { name: 'Diego Souza' } },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('parseGiteaRepo extracts owner/repo from Gitea URLs and rejects GitHub', () => {
  assert.deepEqual(parseGiteaRepo('https://git.cloud.localhost/company/chamados', { env }), {
    owner: 'company',
    repo: 'chamados',
    full_name: 'company/chamados',
  });
  assert.equal(parseGiteaRepo('https://git.cloud.localhost/platform-team/wifi.git', { env }).full_name, 'platform-team/wifi');
  assert.equal(parseGiteaRepo('git@git.cloud.localhost:company/notas.git', { env }).full_name, 'company/notas');
  assert.equal(parseGiteaRepo('company/notas', { env }).full_name, 'company/notas');
  assert.equal(parseGiteaRepo('https://github.com/example-org/painel', { env }), null);
  assert.equal(parseGiteaRepo('', { env }), null);
  assert.equal(parseGiteaRepo(null, { env }), null);
});

test('normalizeRunStatus maps Gitea statuses to portal outcomes', () => {
  assert.equal(normalizeRunStatus('success'), 'success');
  assert.equal(normalizeRunStatus('failure'), 'failed');
  assert.equal(normalizeRunStatus('cancelled'), 'cancelled');
  assert.equal(normalizeRunStatus('running'), 'running');
  assert.equal(normalizeRunStatus('waiting'), 'running');
  assert.equal(normalizeRunStatus('weird'), 'unknown');
});

test('isDeployRun keeps only push runs on main', () => {
  const [pr, push] = tasksPayload().workflow_runs;
  assert.equal(isDeployRun(pr), false);
  assert.equal(isDeployRun(push), true);
  assert.equal(isDeployRun({ ...push, head_branch: 'develop' }), false);
});

test('formatRun exposes sha, times, duration and url', () => {
  const run = formatRun(tasksPayload().workflow_runs[1], {
    repo: { full_name: 'company/chamados' },
    actor: 'DiegoSouza',
  });
  assert.equal(run.outcome, 'success');
  assert.equal(run.short_sha, 'bbbde84');
  assert.equal(run.repo_full_name, 'company/chamados');
  assert.equal(run.actor, 'DiegoSouza');
  assert.equal(run.started_at, '2026-10-14T17:07:09.000Z');
  assert.equal(run.finished_at, '2026-10-14T17:07:44.000Z');
  assert.equal(run.duration_ms, 35000);
  assert.equal(run.url, 'https://git.cloud.localhost/company/chamados/actions/runs/11');
  assert.equal(run.source, 'gitea-actions');

  const running = formatRun(tasksPayload().workflow_runs[3]);
  assert.equal(running.outcome, 'running');
  assert.equal(running.finished_at, null);
  assert.equal(running.duration_ms, null);
});

test('listAppDeploys lists push runs newest first with actor on the latest one', async () => {
  const calls = [];
  const state = createGiteaState({ env, fetchImpl: fakeFetch(calls) });

  const result = await state.listAppDeploys({ slug: 'chamados', repo_url: 'https://git.cloud.localhost/company/chamados' });

  assert.equal(result.available, true);
  assert.equal(result.app_slug, 'chamados');
  assert.equal(result.repo, 'company/chamados');
  assert.equal(result.runs.length, 3);
  assert.deepEqual(result.runs.map((run) => run.id), [9, 11, 10]);
  assert.equal(result.runs[0].actor, 'DiegoSouza');
  assert.equal(result.runs[1].actor, null);
  assert.equal(calls[0].url, 'http://gitea.local:3007/api/v1/repos/company/chamados/actions/tasks?limit=100');
  assert.equal(calls[0].options.headers.authorization, 'token read-only-token');
  assert.match(calls[1].url, /git\/commits\/5555666677778888$/);
});

test('listAppDeploys caches per repo for 60 seconds', async () => {
  const calls = [];
  let clock = 1_000_000;
  const state = createGiteaState({ env, fetchImpl: fakeFetch(calls), now: () => clock });
  const app = { slug: 'chamados', repo_url: 'https://git.cloud.localhost/company/chamados' };

  const first = await state.listAppDeploys(app, { limit: 2 });
  const second = await state.listAppDeploys(app, { limit: 2 });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.runs.length, 2);
  assert.equal(calls.length, 2);

  clock += 61_000;
  const third = await state.listAppDeploys(app);
  assert.equal(third.cached, false);
  assert.equal(calls.length, 4);
});

test('latestAppDeploy returns the newest push run and handles missing repos', async () => {
  const calls = [];
  const state = createGiteaState({ env, fetchImpl: fakeFetch(calls) });

  const latest = await state.latestAppDeploy({ slug: 'chamados', repo_url: 'https://git.cloud.localhost/company/chamados' });
  assert.equal(latest.latest.id, 9);
  assert.equal(latest.latest.outcome, 'running');

  const github = await state.latestAppDeploy({ slug: 'painel', repo_url: 'https://github.com/example-org/painel' });
  assert.equal(github.available, false);
  assert.equal(github.error, 'repo_not_on_gitea');
  assert.equal(github.latest, null);

  const noRepo = await state.latestAppDeploy({ slug: 'x' });
  assert.equal(noRepo.error, 'missing_repo_url');
});

test('listAppDeploys reports Gitea errors without throwing and without caching them', async () => {
  const calls = [];
  const state = createGiteaState({
    env,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: false, status: 503, json: async () => ({}) };
    },
  });
  const app = { slug: 'chamados', repo_url: 'https://git.cloud.localhost/company/chamados' };

  const result = await state.listAppDeploys(app);
  assert.equal(result.available, false);
  assert.equal(result.error, 'gitea_http_503');
  assert.deepEqual(result.runs, []);

  await state.listAppDeploys(app);
  assert.equal(calls.length, 2);
});

test('listAppDeploys is unavailable without GITEA_URL', async () => {
  const state = createGiteaState({ env: {}, fetchImpl: async () => { throw new Error('should not fetch'); } });
  const result = await state.listAppDeploys({ slug: 'a', repo_url: 'https://git.cloud.localhost/company/a' });
  assert.equal(result.available, false);
  assert.equal(result.error, 'missing_gitea_url');
});

test('enrichAppsWithDeploys attaches latest_deploy to each app', async () => {
  const calls = [];
  const state = createGiteaState({ env, fetchImpl: fakeFetch(calls) });
  const apps = await state.enrichAppsWithDeploys([
    { slug: 'chamados', repo_url: 'https://git.cloud.localhost/company/chamados' },
    { slug: 'sem-repo' },
  ]);
  assert.equal(apps[0].latest_deploy.id, 9);
  assert.equal(apps[0].deploys_available, true);
  assert.equal(apps[1].latest_deploy, null);
  assert.equal(apps[1].deploys_available, false);
});
