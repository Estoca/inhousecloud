function firstDomain(domain) {
  if (typeof domain !== 'string' || !domain.trim()) return null;
  return domain
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)[0] ?? null;
}

// Caminho do healthcheck declarado no manifesto do app (runtime.healthcheck.path).
// O inventario guarda esse valor em `healthcheck_path` (ou `healthcheck.path`).
// Sem declaracao, a raiz.
export function appHealthPath(app) {
  const declared = app.healthcheck_path ?? app.healthcheck?.path ?? app.runtime?.healthcheck?.path ?? null;
  const value = typeof declared === 'string' && declared.trim() ? declared.trim() : '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function appHealthUrl(app) {
  const domain = firstDomain(app.domain);
  if (!domain) return null;
  const healthPath = appHealthPath(app);
  return `https://${domain}${healthPath === '/' ? '' : healthPath}`;
}

function appRootUrl(app) {
  const domain = firstDomain(app.domain);
  return domain ? `https://${domain}` : null;
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
  fetchImpl = fetch,
  timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 2500),
  authHost = process.env.AUTHENTIK_HOST,
} = {}) {
  const url = appHealthUrl(app);

  if (!url) {
    return {
      slug: app.slug,
      checked: false,
      ok: false,
      url: null,
      path: appHealthPath(app),
      status: null,
      latency_ms: null,
      redirected_to_auth: false,
      error: 'missing_domain',
    };
  }

  const started = Date.now();
  const { signal, cancel } = timeoutSignal(timeoutMs);

  try {
    // redirect manual: um 302 para o Authentik nao pode virar o 200 da tela de login.
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
    });

    if (isAuthRedirect(url, response, { authHost })) {
      return {
        slug: app.slug,
        checked: true,
        ok: false,
        url,
        path: appHealthPath(app),
        status: response.status,
        latency_ms: Date.now() - started,
        redirected_to_auth: true,
        error: 'auth_redirect',
      };
    }

    return {
      slug: app.slug,
      checked: true,
      ok: response.status >= 200 && response.status < 400,
      url,
      path: appHealthPath(app),
      status: response.status,
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
      path: appHealthPath(app),
      status: null,
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
  fetchImpl = fetch,
  timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 2500),
  authHost = process.env.AUTHENTIK_HOST,
} = {}) {
  const url = appRootUrl(app);
  if (!url) return { checked: false, protected: null };

  const { signal, cancel } = timeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal });
    return { checked: true, protected: isAuthRedirect(url, response, { authHost }) };
  } catch {
    return { checked: false, protected: null };
  } finally {
    cancel();
  }
}

export async function listHttpHealth(apps, options = {}) {
  const checks = await Promise.all(apps.map(async (app) => {
    const [health, sso] = await Promise.all([checkHttpHealth(app, options), checkSsoProtection(app, options)]);
    return { ...health, sso_checked: sso.checked, sso_protected: sso.protected };
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
        sso_checked: Boolean(check?.sso_checked),
        sso_protected: check?.sso_protected ?? null,
        error: check?.error ?? null,
      },
    };

    return {
      ...enriched,
      overall_status: classifyStatus(enriched),
    };
  });
}
