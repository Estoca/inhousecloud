// Historico de deploys lido direto do Gitea Actions.
//
// O portal nao recebe mais eventos dos workflows: cada app que vive no Gitea tem
// um workflow de deploy que roda em push para main, e o historico dessas runs e a
// fonte do "ultimo deploy" e do historico de deploys do app.
//
// Endpoint usado: GET {GITEA_URL}/api/v1/repos/{owner}/{repo}/actions/tasks
// (o Gitea 1.23 nao expoe /actions/runs). A resposta traz `workflow_runs` com
// status, head_sha, head_branch, event, url, created_at, updated_at e
// run_started_at. O ator nao vem na run; para a run mais recente buscamos o
// commit e usamos o autor.
//
// Cache de 60s por repositorio.

import { readPlatformConfig } from './config.js';

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_LIMIT = 20;

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function giteaConfigFromEnv(env = process.env) {
  const platform = readPlatformConfig(env);
  return {
    url: platform.giteaUrl,
    token: cleanText(env.GITEA_TOKEN),
    publicUrl: platform.giteaPublicUrl,
  };
}

// Extrai `owner/repo` de uma URL de repositorio hospedado no Gitea. URLs do
// GitHub (ou qualquer outra forja) devolvem null: la nao ha Gitea Actions.
export function parseGiteaRepo(repoUrl, { env = process.env } = {}) {
  const value = cleanText(repoUrl);
  if (!value) return null;
  if (/github\.com[/:]/i.test(value)) return null;

  const withoutGit = value.replace(/\.git$/i, '');
  const ssh = withoutGit.match(/^git@[^:]+:([^/\s]+)\/([^/\s]+)$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2], full_name: `${ssh[1]}/${ssh[2]}` };

  let url;
  try {
    url = new URL(withoutGit);
  } catch {
    const short = withoutGit.match(/^([^/\s]+)\/([^/\s]+)$/);
    return short ? { owner: short[1], repo: short[2], full_name: `${short[1]}/${short[2]}` } : null;
  }

  const config = giteaConfigFromEnv(env);
  const knownHosts = [config.url, config.publicUrl]
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).host.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (knownHosts.length > 0 && !knownHosts.includes(url.host.toLowerCase())) {
    // Host desconhecido: so aceitamos se o caminho tiver a cara de owner/repo e
    // nao for uma forja conhecida que nao e Gitea.
    if (/gitlab\.com|bitbucket\.org/i.test(url.host)) return null;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1], full_name: `${parts[0]}/${parts[1]}` };
}

export function normalizeRunStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'failure' || value === 'failed' || value === 'error') return 'failed';
  if (value === 'cancelled' || value === 'canceled' || value === 'skipped') return 'cancelled';
  if (value === 'running' || value === 'waiting' || value === 'blocked' || value === 'pending') return 'running';
  return 'unknown';
}

function toIso(value) {
  const text = cleanText(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function formatRun(run, { repo, actor = null } = {}) {
  const outcome = normalizeRunStatus(run.status);
  const startedAt = toIso(run.run_started_at) ?? toIso(run.created_at);
  const finishedAt = outcome === 'running' ? null : toIso(run.updated_at);
  const sha = cleanText(run.head_sha);
  return {
    id: run.id ?? null,
    run_number: run.run_number ?? null,
    repo_full_name: repo?.full_name ?? null,
    workflow: cleanText(run.workflow_id) ?? cleanText(run.name),
    name: cleanText(run.name),
    title: cleanText(run.display_title),
    event: cleanText(run.event),
    branch: cleanText(run.head_branch),
    status: cleanText(run.status) ?? 'unknown',
    outcome,
    commit_sha: sha,
    short_sha: sha ? sha.slice(0, 7) : null,
    actor,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    url: cleanText(run.url),
    source: 'gitea-actions',
  };
}

// So runs de push sao deploys. Runs de pull_request sao checks de PR.
export function isDeployRun(run, { branch = 'main' } = {}) {
  return cleanText(run.event) === 'push' && (!branch || cleanText(run.head_branch) === branch);
}

export function createGiteaState({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  const cache = new Map();

  function unavailable(error, repo = null) {
    return {
      available: false,
      source: 'gitea-actions',
      repo: repo?.full_name ?? null,
      error,
      fetched_at: null,
      runs: [],
    };
  }

  async function apiJson(path) {
    const config = giteaConfigFromEnv(env);
    const response = await fetchImpl(`${config.url}${path}`, {
      headers: {
        accept: 'application/json',
        ...(config.token ? { authorization: `token ${config.token}` } : {}),
      },
    });
    if (!response.ok) {
      const error = new Error(`gitea_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function fetchRuns(repo, { limit }) {
    const body = await apiJson(`/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/tasks?limit=${limit}`);
    const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    runs.sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0));
    return runs;
  }

  async function fetchActor(repo, sha) {
    if (!sha) return null;
    try {
      const commit = await apiJson(`/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/commits/${sha}`);
      return cleanText(commit?.author?.login)
        ?? cleanText(commit?.commit?.author?.name)
        ?? cleanText(commit?.commit?.author?.email)
        ?? null;
    } catch {
      return null;
    }
  }

  // Lista as runs de deploy (push em main) de um repo, mais recentes primeiro.
  async function listRuns(repo, { limit = DEFAULT_LIMIT, branch = 'main' } = {}) {
    const config = giteaConfigFromEnv(env);
    if (!repo) return unavailable('repo_not_on_gitea');
    if (!config.url) return unavailable('missing_gitea_url', repo);

    const key = `${repo.full_name}:${branch}`;
    const cached = cache.get(key);
    const current = now();
    if (cached && cached.expiresAt > current) {
      return { ...cached.value, cached: true, runs: cached.value.runs.slice(0, limit) };
    }
    if (cached?.pending) {
      const value = await cached.pending;
      return { ...value, cached: true, runs: value.runs.slice(0, limit) };
    }

    const pending = (async () => {
      try {
        const allRuns = (await fetchRuns(repo, { limit: 100 })).filter((run) => isDeployRun(run, { branch }));
        const latestActor = allRuns.length > 0 ? await fetchActor(repo, allRuns[0].head_sha) : null;
        const value = {
          available: true,
          source: 'gitea-actions',
          repo: repo.full_name,
          error: null,
          fetched_at: new Date(now()).toISOString(),
          runs: allRuns.map((run, index) => formatRun(run, {
            repo,
            actor: index === 0 ? latestActor : null,
          })),
        };
        cache.set(key, { value, expiresAt: now() + cacheTtlMs, pending: null });
        return value;
      } catch (error) {
        cache.delete(key);
        return unavailable(error.message, repo);
      }
    })();
    cache.set(key, { value: cached?.value ?? null, expiresAt: 0, pending });
    const value = await pending;
    return { ...value, cached: false, runs: value.runs.slice(0, limit) };
  }

  async function listAppDeploys(app, options = {}) {
    const repo = parseGiteaRepo(app?.repo_url, { env });
    if (!repo) {
      return {
        ...unavailable(app?.repo_url ? 'repo_not_on_gitea' : 'missing_repo_url'),
        app_slug: app?.slug ?? null,
        cached: false,
      };
    }
    const result = await listRuns(repo, options);
    return { ...result, app_slug: app?.slug ?? null };
  }

  async function latestAppDeploy(app) {
    const result = await listAppDeploys(app, { limit: 1 });
    return {
      ...result,
      latest: result.runs[0] ?? null,
    };
  }

  // Para a lista de apps: enriquece cada app com o ultimo deploy, em paralelo.
  async function enrichAppsWithDeploys(apps) {
    const results = await Promise.all(apps.map((app) => latestAppDeploy(app)));
    return apps.map((app, index) => ({
      ...app,
      latest_deploy: results[index].latest,
      deploys_available: results[index].available,
    }));
  }

  return {
    listRuns,
    listAppDeploys,
    latestAppDeploy,
    enrichAppsWithDeploys,
    clearCache: () => cache.clear(),
  };
}

let sharedState = null;

export function getGiteaState() {
  if (!sharedState) sharedState = createGiteaState();
  return sharedState;
}
