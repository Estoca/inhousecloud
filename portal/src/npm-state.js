function splitDomains(domain) {
  if (typeof domain !== 'string' || !domain.trim()) return [];
  return domain
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function configFromEnv(env = process.env) {
  return {
    url: env.NPM_URL,
    email: env.NPM_EMAIL,
    password: env.NPM_PASSWORD,
  };
}

function missingConfig(config) {
  return ['url', 'email', 'password'].filter((key) => !config[key]);
}

async function authenticateNpm(config, fetchImpl) {
  const missing = missingConfig(config);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `missing_config:${missing.join(',')}`,
      token: null,
    };
  }

  const baseUrl = config.url.replace(/\/+$/, '');
  const tokenResponse = await fetchImpl(`${baseUrl}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identity: config.email,
      secret: config.password,
    }),
  });

  if (!tokenResponse.ok) {
    return {
      ok: false,
      error: `auth_failed:${tokenResponse.status}`,
      token: null,
    };
  }

  const tokenBody = await tokenResponse.json();
  return {
    ok: true,
    token: tokenBody.token,
    baseUrl,
  };
}

export function normalizeProxyHost(row) {
  return {
    id: row.id,
    domain_names: row.domain_names ?? [],
    enabled: row.enabled !== false,
    forward_scheme: row.forward_scheme,
    forward_host: row.forward_host,
    forward_port: Number(row.forward_port),
    ssl_forced: Boolean(row.ssl_forced),
    certificate_id: row.certificate_id ?? null,
  };
}

export function normalizeRedirectionHost(row) {
  return {
    id: row.id,
    domain_names: row.domain_names ?? [],
    enabled: row.enabled !== false,
    forward_http_code: Number(row.forward_http_code),
    forward_scheme: row.forward_scheme,
    forward_domain_name: row.forward_domain_name,
    preserve_path: row.preserve_path !== false,
    ssl_forced: Boolean(row.ssl_forced),
    certificate_id: row.certificate_id ?? null,
  };
}

export async function listNpmProxyHosts({ env = process.env, fetchImpl = fetch } = {}) {
  const config = configFromEnv(env);

  try {
    const auth = await authenticateNpm(config, fetchImpl);
    if (!auth.ok) {
      return {
        available: false,
        error: auth.error,
        proxy_hosts: [],
      };
    }

    const hostsResponse = await fetchImpl(`${auth.baseUrl}/api/nginx/proxy-hosts`, {
      headers: {
        authorization: `Bearer ${auth.token}`,
      },
    });

    if (!hostsResponse.ok) {
      return {
        available: false,
        error: `list_failed:${hostsResponse.status}`,
        proxy_hosts: [],
      };
    }

    const rows = await hostsResponse.json();
    return {
      available: true,
      proxy_hosts: rows.map(normalizeProxyHost),
    };
  } catch (error) {
    return {
      available: false,
      error: error.message,
      proxy_hosts: [],
    };
  }
}

export function enrichAppsWithNpm(apps, npmState) {
  const byDomain = new Map();
  const disabledByDomain = new Map();

  for (const host of npmState.proxy_hosts) {
    for (const domain of host.domain_names) {
      if (host.enabled === false) {
        disabledByDomain.set(domain, host);
      } else {
        byDomain.set(domain, host);
      }
    }
  }

  const enriched = apps.map((app) => {
    const domains = splitDomains(app.domain);
    const matchedHost = domains.map((domain) => byDomain.get(domain)).find(Boolean) ?? null;
    const disabledHost = domains.map((domain) => disabledByDomain.get(domain)).find(Boolean) ?? null;

    return {
      ...app,
      proxy: {
        source: 'nginx-proxy-manager',
        available: npmState.available,
        matched: Boolean(matchedHost),
        disabled: Boolean(!matchedHost && disabledHost),
        inherited: false,
        inherited_from_app_slug: null,
        inherited_from_domain: null,
        host: matchedHost,
        disabled_host: disabledHost,
        error: npmState.available ? null : npmState.error,
      },
    };
  });

  const proxyByStack = new Map();
  for (const app of enriched) {
    const stack = app.runtime?.stack || app.docker_stack || app.runtime?.container?.docker_stack;
    if (!stack || !app.proxy?.matched) continue;
    if (!proxyByStack.has(stack)) {
      proxyByStack.set(stack, {
        app_slug: app.slug,
        domain: splitDomains(app.domain)[0] ?? null,
        host: app.proxy.host,
      });
    }
  }

  return enriched.map((app) => {
    const domains = splitDomains(app.domain);
    const stack = app.runtime?.stack || app.docker_stack || app.runtime?.container?.docker_stack;
    const inheritedProxy = stack ? proxyByStack.get(stack) : null;
    if (app.proxy?.matched || domains.length > 0 || !inheritedProxy) return app;

    return {
      ...app,
      proxy: {
        ...app.proxy,
        matched: true,
        disabled: false,
        inherited: true,
        inherited_from_app_slug: inheritedProxy.app_slug,
        inherited_from_domain: inheritedProxy.domain,
        host: inheritedProxy.host,
        disabled_host: null,
      },
    };
  });
}
