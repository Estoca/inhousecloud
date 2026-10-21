import test from 'node:test';
import assert from 'node:assert/strict';
import { publicPlatformConfig, readPlatformConfig } from '../src/config.js';

test('readPlatformConfig defaults to a local InHouseCloud installation', () => {
  const config = readPlatformConfig({});
  assert.equal(config.companyName, 'Company');
  assert.equal(config.baseDomain, 'cloud.localhost');
  assert.equal(config.portalHost, 'portal.cloud.localhost');
  assert.equal(config.portalUrl, 'http://portal.cloud.localhost');
  assert.deepEqual(config.orgEmailDomains, ['example.com']);
  assert.equal(config.giteaPublicUrl, 'http://git.cloud.localhost');
  assert.equal(config.giteaHost, 'git.cloud.localhost');
  assert.equal(config.giteaOrg, 'company');
  assert.equal(config.authentikUrl, 'http://auth.cloud.localhost');
  assert.equal(config.authentikInternalUrl, 'http://auth.cloud.localhost');
  assert.equal(config.proxyUrl, 'http://proxy:80');
  assert.equal(config.project, 'ihc');
  assert.deepEqual(config.profiles, []);
  assert.equal(config.tunnelProvider, 'none');
  assert.equal(config.timezone, 'UTC');
  assert.equal(config.manifestFilename, 'company-app.yaml');
  assert.deepEqual(config.manifestAliases, ['app.yaml']);
  assert.equal(config.adminGroup, 'ihc-admins');
  assert.equal(config.userGroup, 'ihc-users');
});

test('URLs derive from BASE_DOMAIN, with https outside localhost', () => {
  const config = readPlatformConfig({ BASE_DOMAIN: 'cloud.example.internal' });
  assert.equal(config.portalUrl, 'https://portal.cloud.example.internal');
  assert.equal(config.giteaPublicUrl, 'https://git.cloud.example.internal');
  assert.equal(config.authentikUrl, 'https://auth.cloud.example.internal');
});

test('the scheme of PUBLIC_BASE_URL wins for every derived link', () => {
  const config = readPlatformConfig({ BASE_DOMAIN: 'cloud.localhost', PUBLIC_BASE_URL: 'https://portal.cloud.localhost/' });
  assert.equal(config.portalUrl, 'https://portal.cloud.localhost');
  assert.equal(config.giteaPublicUrl, 'https://git.cloud.localhost');
  assert.equal(config.scheme, 'https');
});

test('readPlatformConfig takes every value from the environment (the cloud compose service)', () => {
  const config = readPlatformConfig({
    COMPANY_NAME: 'Acme',
    BASE_DOMAIN: 'acme.cloud',
    ORG_EMAIL_DOMAINS: 'acme.com, acme.io',
    GITEA_URL: 'http://gitea:3000/',
    GITEA_PUBLIC_URL: 'https://code.acme.cloud/',
    GITEA_ORG: 'Acme',
    AUTHENTIK_URL: 'https://sso.acme.cloud',
    AUTHENTIK_INTERNAL_URL: 'http://authentik-server:9000/',
    IHC_PROXY_URL: 'http://proxy:80/',
    IHC_PROJECT: 'acme',
    COMPOSE_PROFILES: 'storage,backup,ops',
    TUNNEL_PROVIDER: 'cloudflared',
    TIMEZONE: 'Europe/Lisbon',
    MANIFEST_FILENAME: 'acme-app.yaml',
    MANIFEST_FILENAME_ALIASES: 'app.yaml,acme-app.yaml',
    ADMIN_GROUP: 'acme-admins',
  });
  assert.equal(config.companyName, 'Acme');
  assert.equal(config.portalHost, 'portal.acme.cloud');
  assert.deepEqual(config.orgEmailDomains, ['acme.com', 'acme.io']);
  assert.equal(config.emailDomain, 'acme.com');
  assert.equal(config.giteaUrl, 'http://gitea:3000');
  assert.equal(config.giteaHost, 'code.acme.cloud');
  assert.equal(config.authentikHost, 'sso.acme.cloud');
  assert.equal(config.authentikInternalUrl, 'http://authentik-server:9000');
  assert.equal(config.proxyUrl, 'http://proxy:80');
  assert.equal(config.project, 'acme');
  assert.deepEqual(config.profiles, ['storage', 'backup', 'ops']);
  assert.equal(config.tunnelProvider, 'cloudflared');
  assert.equal(config.timezone, 'Europe/Lisbon');
  assert.deepEqual(config.manifestAliases, ['app.yaml']);
  assert.equal(config.adminGroup, 'acme-admins');
});

test('legacy variable names still work', () => {
  const config = readPlatformConfig({
    PORTAL_USER_DOMAINS: 'legado.com',
    AUTHENTIK_HOST: 'auth.legado.com',
    PUBLIC_BASE_URL: 'https://portal.legado.com',
  });
  assert.deepEqual(config.orgEmailDomains, ['legado.com']);
  assert.equal(config.authentikUrl, 'https://auth.legado.com');
  assert.equal(config.portalHost, 'portal.legado.com');
});

test('publicPlatformConfig exposes no secret and no machine topology', () => {
  const summary = publicPlatformConfig(readPlatformConfig({ GITEA_TOKEN: 'secret', GITEA_URL: 'http://gitea:3000' }));
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(summary.gitea_url, 'http://git.cloud.localhost');
  assert.equal(summary.read_only, true);
  for (const key of ['deploy_root', 'port_range', 'upstream_host', 'outpost_host', 'agent_name', 'gitops_repo']) {
    assert.equal(key in summary, false, key);
  }
});
