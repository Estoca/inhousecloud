import http from 'node:http';
import https from 'node:https';
import { readPlatformConfig } from './config.js';

// Saude e SSO de cada app, sondados pelo proxy do cloud com o header Host do app
// (http://proxy:80<path>, Host: <slug>.<BASE_DOMAIN>), o mesmo criterio de `ihc doctor`,
// `ihc-app wait` e do smoke test 16. Funciona nos tres modos de ingress: de dentro do
// container, o nome publico do app pode nao resolver (ou resolver para o proprio container).

function firstDomain(domain) {
  if (typeof domain !== 'string' || !domain.trim()) return null;
  return domain
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)[0] ?? null;
}

// Caminho do healthcheck declarado no manifesto do app (runtime.healthcheck.path).
// O inventario guarda esse valor em `healthcheck.path` (ou `healthcheck_path`).
// Sem declaracao, a raiz.
export function appHealthPath(app) {
  const declared = app.healthcheck?.path ?? app.healthcheck_path ?? app.runtime?.healthcheck?.path ?? null;
  const value = typeof declared === 'string' && declared.trim() ? declared.trim() : '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function expectedStatus(app) {
  const value = Number(app.healthcheck?.expected_status ?? app.healthcheck?.status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function publicUrl(app, path, config) {
  const domain = firstDomain(app.domain);
  if (!domain) return null;
  return `${config.scheme}://${domain}${path === '/' ? '' : path}`;
}

// GET sem seguir redirect, com Host proprio: o fetch do Node nao deixa trocar o Host.
export function proxyGet(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method: 'GET', headers, signal }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// fetchImpl(url, init) para os testes; no cloud, proxyGet pelo proxy.
function probe(fetchImpl, app, path, { config, signal }) {
  const domain = firstDomain(app.domain);
  return fetchImpl(`${config.proxyUrl}${path}`, { method: 'GET', redirect: 'manual', signal, headers: { host: domain } });
}

function sameHost(a, b) {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

// Redirect para o Authentik (ou para qualquer outro host) significa que o proxy
// barrou a chamada anonima antes de chegar no app. Nao sabemos se o app esta
// saudavel: `unknown`, nunca `healthy`.
export function isAuthRedirect(url, response, { authHost = process.env.AUTHENTIK_HOST } = {}) {
  if (!response || response.status < 300 || response.status >= 400) return false;
  const location = typeof response.headers?.get === 'function' ? response.headers.get('location') : null;
  if (!location) return true;
  let target;
  try {
    target = new URL(location, url);
  } catch {
    return true;
  }
  if (/goauthentik\.io|\/outpost\.|\/if\/flow\//i.test(target.href)) return true;
  if (authHost && target.host.toLowerCase() === String(authHost).toLowerCase()) return true;
  return !sameHost(url, target.href);
}

function classifyStatus(app) {
  const runtimeMatched = app.runtime?.matched;
  const proxyMatched = app.proxy?.matched;
  const healthChecked = app.health?.checked;
  const healthOk = app.health?.ok;

  if (healthChecked && app.health?.redirected_to_auth) {
    return runtimeMatched === false || proxyMatched === false ? 'warning' : 'unknown';
  }

  if (healthChecked && !healthOk) {
    return 'error';
  }

  if (runtimeMatched === false || proxyMatched === false) {
    return 'warning';
  }

  if (healthChecked && healthOk && runtimeMatched !== false && proxyMatched !== false) {
    return 'healthy';
  }

  return 'unknown';
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timeout) };
}

export async function checkHttpHealth(app, {
  fetchImpl = proxyGet,
  timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 2500),
  authHost = process.env.AUTHENTIK_HOST,
  config = readPlatformConfig(),
} = {}) {
  const path = appHealthPath(app);
  const url = publicUrl(app, path, config);
  const expected = expectedStatus(app);

  if (!url) {
    return {
      slug: app.slug,
      checked: false,
      ok: false,
      url: null,
      path,
      status: null,
      expected_status: expected,
      latency_ms: null,
      redirected_to_auth: false,
      error: 'missing_domain',
    };
  }

  const started = Date.now();
  const { signal, cancel } = timeoutSignal(timeoutMs);

  try {
    // redirect manual: um 302 para o Authentik nao pode virar o 200 da tela de login.
    const response = await probe(fetchImpl, app, path, { config, signal });

    if (isAuthRedirect(url, response, { authHost })) {
      return {
        slug: app.slug,
        checked: true,
        ok: false,
        url,
        path,
        status: response.status,
        expected_status: expected,
        latency_ms: Date.now() - started,
        redirected_to_auth: true,
        error: 'auth_redirect',
      };
    }

    return {
      slug: app.slug,
      checked: true,
      ok: expected ? response.status === expected : response.status >= 200 && response.status < 400,
      url,
      path,
      status: response.status,
      expected_status: expected,
      latency_ms: Date.now() - started,
      redirected_to_auth: false,
      error: null,
    };
  } catch (error) {
    return {
      slug: app.slug,
      checked: true,
      ok: false,
      url,
      path,
      status: null,
      expected_status: expected,
      latency_ms: Date.now() - started,
      redirected_to_auth: false,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  } finally {
    cancel();
  }
}

// A raiz representa a experiencia de acesso do usuario. Diferentemente do
// healthcheck, ela deve redirecionar anonimos ao Authentik quando o app usa SSO.
export async function checkSsoProtection(app, {
  fetchImpl = proxyGet,
  timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 2500),
  authHost = process.env.AUTHENTIK_HOST,
  config = readPlatformConfig(),
} = {}) {
  const url = publicUrl(app, '/', config);
  if (!url) return { checked: false, protected: null, status: null };

  const { signal, cancel } = timeoutSignal(timeoutMs);
  try {
    const response = await probe(fetchImpl, app, '/', { config, signal });
    return { checked: true, protected: isAuthRedirect(url, response, { authHost }), status: response.status };
  } catch {
    return { checked: false, protected: null, status: null };
  } finally {
    cancel();
  }
}

export async function listHttpHealth(apps, options = {}) {
  const checks = await Promise.all(apps.map(async (app) => {
    const [health, sso] = await Promise.all([checkHttpHealth(app, options), checkSsoProtection(app, options)]);
    // SSO efetivo: o manifesto pede auth e a raiz manda anonimos ao Authentik.
    const ssoEffective = sso.checked ? (app.auth_required === false ? !sso.protected : Boolean(sso.protected)) : null;
    return {
      ...health,
      sso_checked: sso.checked,
      sso_protected: sso.protected,
      sso_expected: app.auth_required !== false,
      sso_effective: ssoEffective,
      route_status: sso.status,
      // A rota existe quando a raiz manda ao SSO ou o health path nao e 404: para um host
      // que o proxy nao conhece, a raiz responde 200 (a pagina padrao) e o resto 404.
      route_ok: sso.checked || health.checked ? Boolean(sso.protected) || (health.status != null && health.status !== 404) : null,
    };
  }));

  return {
    available: true,
    checked_at: new Date().toISOString(),
    timeout_ms: Number(options.timeoutMs ?? process.env.HEALTHCHECK_TIMEOUT_MS ?? 2500),
    checks,
  };
}

export function enrichAppsWithHealth(apps, healthState) {
  const bySlug = new Map(healthState.checks.map((check) => [check.slug, check]));

  return apps.map((app) => {
    const check = bySlug.get(app.slug) ?? null;
    const enriched = {
      ...app,
      health: {
        source: 'http',
        available: healthState.available,
        checked: Boolean(check?.checked),
        ok: Boolean(check?.ok),
        url: check?.url ?? null,
        path: check?.path ?? null,
        status: check?.status ?? null,
        latency_ms: check?.latency_ms ?? null,
        redirected_to_auth: Boolean(check?.redirected_to_auth),
        expected_status: check?.expected_status ?? null,
        sso_checked: Boolean(check?.sso_checked),
        sso_protected: check?.sso_protected ?? null,
        sso_expected: check?.sso_expected ?? null,
        sso_effective: check?.sso_effective ?? null,
        route_status: check?.route_status ?? null,
        route_ok: check?.route_ok ?? null,
        error: check?.error ?? null,
      },
      // A rota no proxy, pelo que ela responde com o Host do app (route_ok acima). O portal
      // nao le a API de admin do proxy (nem tem a senha dela).
      proxy: {
        source: 'proxy-probe',
        available: Boolean(check?.sso_checked),
        matched: check?.route_ok ?? undefined,
        status: check?.route_status ?? null,
      },
    };

    return {
      ...enriched,
      overall_status: classifyStatus(enriched),
    };
  });
}
