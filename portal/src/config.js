// Configuracao da plataforma: tudo que e especifico da instalacao (dominios,
// hosts, grupos, perfis, fuso, nome do manifesto) vem de variaveis de ambiente.
// Os padroes sao os de uma instalacao local do InHouseCloud (cloud.localhost);
// no cloud, o servico `portal` de docker/compose.yml passa cada valor.
//
// Documentacao de cada variavel: README.md ("Variaveis") e .env.example.

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripSlash(value) {
  return cleanText(value)?.replace(/\/+$/, '') ?? null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export const PLATFORM_DEFAULTS = Object.freeze({
  companyName: 'Company',
  baseDomain: 'cloud.localhost',
  orgEmailDomains: ['example.com'],
  giteaOrg: 'company',
  timezone: 'UTC',
  manifestFilename: 'company-app.yaml',
  manifestAliases: ['app.yaml'],
  adminGroup: 'ihc-admins',
  userGroup: 'ihc-users',
  project: 'ihc',
  proxyUrl: 'http://proxy:80',
});

// URLs derivadas do BASE_DOMAIN: http para *.localhost (instalacao local, sem
// certificado), https para o resto. Com PUBLIC_BASE_URL, o esquema dele vale para
// todos os links (TLS internal num dominio .localhost, por exemplo).
function schemeFor(domain) {
  return /(^|\.)localhost$/.test(domain) ? 'http' : 'https';
}

export function readPlatformConfig(env = process.env) {
  const baseDomain = cleanText(env.BASE_DOMAIN) || PLATFORM_DEFAULTS.baseDomain;
  const companyName = cleanText(env.COMPANY_NAME) || PLATFORM_DEFAULTS.companyName;
  const publicBaseUrl = stripSlash(env.PUBLIC_BASE_URL);
  const scheme = (publicBaseUrl && publicBaseUrl.split('://')[0]) || schemeFor(baseDomain);
  const portalHost = cleanText(env.PORTAL_HOST) || hostOf(publicBaseUrl) || `portal.${baseDomain}`;
  const orgEmailDomains = parseList(env.ORG_EMAIL_DOMAINS || env.PORTAL_USER_DOMAINS);
  const emailDomains = orgEmailDomains.length > 0 ? orgEmailDomains : [...PLATFORM_DEFAULTS.orgEmailDomains];
  const giteaUrl = stripSlash(env.GITEA_URL);
  const giteaPublicUrl = stripSlash(env.GITEA_PUBLIC_URL) || `${scheme}://git.${baseDomain}`;
  const authentikUrl = stripSlash(env.AUTHENTIK_URL)
    || (cleanText(env.AUTHENTIK_HOST) ? `${schemeFor(cleanText(env.AUTHENTIK_HOST))}://${cleanText(env.AUTHENTIK_HOST)}` : `${scheme}://auth.${baseDomain}`);
  const manifestFilename = cleanText(env.MANIFEST_FILENAME) || PLATFORM_DEFAULTS.manifestFilename;
  const manifestAliases = parseList(env.MANIFEST_FILENAME_ALIASES);

  return {
    companyName,
    baseDomain,
    scheme,
    portalHost,
    portalUrl: publicBaseUrl || `${schemeFor(portalHost)}://${portalHost}`,
    orgEmailDomains: emailDomains,
    emailDomain: emailDomains[0],
    giteaUrl,
    giteaPublicUrl,
    giteaHost: hostOf(giteaPublicUrl) || `git.${baseDomain}`,
    giteaOrg: cleanText(env.GITEA_ORG) || PLATFORM_DEFAULTS.giteaOrg,
    authentikUrl,
    authentikHost: hostOf(authentikUrl) || `auth.${baseDomain}`,
    // Endereco interno para o health do Authentik (o publico pode nao resolver de dentro).
    authentikInternalUrl: stripSlash(env.AUTHENTIK_INTERNAL_URL) || authentikUrl,
    // O proxy do cloud: apps e rotas sao sondados por ele, com o header Host do app,
    // como `ihc doctor` faz. Funciona nos tres modos de ingress.
    proxyUrl: stripSlash(env.IHC_PROXY_URL) || PLATFORM_DEFAULTS.proxyUrl,
    project: cleanText(env.IHC_PROJECT) || PLATFORM_DEFAULTS.project,
    profiles: parseList(env.COMPOSE_PROFILES),
    ingress: cleanText(env.INGRESS) || 'local',
    tunnelProvider: cleanText(env.TUNNEL_PROVIDER) || 'none',
    timezone: cleanText(env.TIMEZONE) || PLATFORM_DEFAULTS.timezone,
    manifestFilename,
    manifestAliases: (manifestAliases.length > 0 ? manifestAliases : [...PLATFORM_DEFAULTS.manifestAliases])
      .filter((alias) => alias !== manifestFilename),
    adminGroup: cleanText(env.ADMIN_GROUP) || PLATFORM_DEFAULTS.adminGroup,
    userGroup: cleanText(env.USER_GROUP) || PLATFORM_DEFAULTS.userGroup,
  };
}

// Resumo sem segredo da configuracao, para a UI e para LLMs.
export function publicPlatformConfig(config = readPlatformConfig()) {
  return {
    company_name: config.companyName,
    base_domain: config.baseDomain,
    portal_url: config.portalUrl,
    org_email_domains: config.orgEmailDomains,
    gitea_url: config.giteaPublicUrl,
    gitea_org: config.giteaOrg,
    authentik_url: config.authentikUrl,
    ingress: config.ingress,
    tunnel_provider: config.tunnelProvider,
    profiles: config.profiles,
    timezone: config.timezone,
    manifest_filename: config.manifestFilename,
    manifest_aliases: config.manifestAliases,
    admin_group: config.adminGroup,
    user_group: config.userGroup,
    // Primeira versao so leitura: descricao, dono e categoria mudam no
    // company-app.yaml do repo do app, por push.
    read_only: true,
  };
}
