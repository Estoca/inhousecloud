// Configuracao da plataforma: tudo que e especifico da instalacao (dominios,
// hosts, caminhos, faixa de portas, fuso, nome do manifesto)
// vem de variaveis de ambiente. Os padroes sao os de uma instalacao local do
// InHouseCloud (cloud.localhost); cada instalacao troca so o .env.
//
// Documentacao de cada variavel: .env.example.

import path from 'node:path';

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

export function parsePortRange(value, fallback = { start: 8100, end: 8999 }) {
  const match = String(value ?? '').trim().match(/^(\d{2,5})\s*[-:]\s*(\d{2,5})$/);
  if (!match) return { ...fallback };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    return { ...fallback };
  }
  return { start, end };
}

export const PLATFORM_DEFAULTS = Object.freeze({
  companyName: 'Company',
  baseDomain: 'cloud.localhost',
  orgEmailDomains: ['example.com'],
  giteaOrg: 'company',
  templateRepo: 'company-app-template',
  outpostHost: 'authentik-server',
  outpostPort: 9000,
  upstreamHost: 'proxy',
  deployRoot: '/opt/inhousecloud/apps',
  portRange: { start: 8100, end: 8999 },
  timezone: 'UTC',
  manifestFilename: 'company-app.yaml',
  manifestAliases: ['app.yaml'],
  adminGroup: 'ihc-admins',
  userGroup: 'ihc-users',
});

// URLs derivadas do BASE_DOMAIN: http para *.localhost (instalacao local, sem
// certificado), https para o resto.
function schemeFor(domain) {
  return /(^|\.)localhost$/.test(domain) ? 'http' : 'https';
}

export function readPlatformConfig(env = process.env) {
  const baseDomain = cleanText(env.BASE_DOMAIN) || PLATFORM_DEFAULTS.baseDomain;
  const companyName = cleanText(env.COMPANY_NAME) || PLATFORM_DEFAULTS.companyName;
  const scheme = schemeFor(baseDomain);
  const portalHost = cleanText(env.PORTAL_HOST) || hostOf(env.PUBLIC_BASE_URL) || `portal.${baseDomain}`;
  const orgEmailDomains = parseList(env.ORG_EMAIL_DOMAINS || env.PORTAL_USER_DOMAINS);
  const emailDomains = orgEmailDomains.length > 0 ? orgEmailDomains : [...PLATFORM_DEFAULTS.orgEmailDomains];
  const giteaUrl = stripSlash(env.GITEA_URL);
  const giteaPublicUrl = stripSlash(env.GITEA_PUBLIC_URL) || `${scheme}://git.${baseDomain}`;
  const authentikUrl = stripSlash(env.AUTHENTIK_URL)
    || (cleanText(env.AUTHENTIK_HOST) ? `${schemeFor(cleanText(env.AUTHENTIK_HOST))}://${cleanText(env.AUTHENTIK_HOST)}` : `${scheme}://auth.${baseDomain}`);
  const deployRoot = stripSlash(env.DEPLOY_ROOT) || PLATFORM_DEFAULTS.deployRoot;
  const manifestFilename = cleanText(env.MANIFEST_FILENAME) || PLATFORM_DEFAULTS.manifestFilename;
  const manifestAliases = parseList(env.MANIFEST_FILENAME_ALIASES);

  return {
    companyName,
    baseDomain,
    portalHost,
    portalUrl: stripSlash(env.PUBLIC_BASE_URL) || `${schemeFor(portalHost)}://${portalHost}`,
    orgEmailDomains: emailDomains,
    emailDomain: emailDomains[0],
    giteaUrl,
    giteaPublicUrl,
    giteaHost: hostOf(giteaPublicUrl) || `git.${baseDomain}`,
    giteaOrg: cleanText(env.GITEA_ORG) || PLATFORM_DEFAULTS.giteaOrg,
    templateRepo: cleanText(env.TEMPLATE_REPO) || PLATFORM_DEFAULTS.templateRepo,
    authentikUrl,
    authentikHost: hostOf(authentikUrl) || `auth.${baseDomain}`,
    outpostHost: cleanText(env.OUTPOST_HOST) || cleanText(env.AUTHENTIK_OUTPOST_FORWARD_HOST) || PLATFORM_DEFAULTS.outpostHost,
    outpostPort: Number(env.OUTPOST_PORT || env.AUTHENTIK_OUTPOST_FORWARD_PORT) || PLATFORM_DEFAULTS.outpostPort,
    upstreamHost: cleanText(env.UPSTREAM_HOST) || cleanText(env.NPM_FORWARD_HOST) || PLATFORM_DEFAULTS.upstreamHost,
    deployRoot,
    deployDataRoot: path.dirname(deployRoot),
    portRange: parsePortRange(env.PORT_RANGE, PLATFORM_DEFAULTS.portRange),
    timezone: cleanText(env.TIMEZONE) || PLATFORM_DEFAULTS.timezone,
    manifestFilename,
    manifestAliases: (manifestAliases.length > 0 ? manifestAliases : [...PLATFORM_DEFAULTS.manifestAliases])
      .filter((alias) => alias !== manifestFilename),
    adminGroup: cleanText(env.ADMIN_GROUP) || PLATFORM_DEFAULTS.adminGroup,
    userGroup: cleanText(env.USER_GROUP) || PLATFORM_DEFAULTS.userGroup,
  };
}

export function portRangeLabel(config) {
  return `${config.portRange.start}-${config.portRange.end}`;
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
    upstream_host: config.upstreamHost,
    outpost_host: config.outpostHost,
    outpost_port: config.outpostPort,
    deploy_root: config.deployRoot,
    port_range: { ...config.portRange, label: portRangeLabel(config) },
    timezone: config.timezone,
    manifest_filename: config.manifestFilename,
    manifest_aliases: config.manifestAliases,
    admin_group: config.adminGroup,
    user_group: config.userGroup,
  };
}
