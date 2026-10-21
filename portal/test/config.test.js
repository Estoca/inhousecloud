import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePortRange, publicPlatformConfig, readPlatformConfig } from '../src/config.js';

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
  assert.equal(config.outpostHost, 'authentik-server');
  assert.equal(config.outpostPort, 9000);
  assert.equal(config.upstreamHost, 'proxy');
  assert.equal(config.deployRoot, '/opt/inhousecloud/apps');
  assert.equal(config.deployDataRoot, '/opt/inhousecloud');
  assert.deepEqual(config.portRange, { start: 8100, end: 8999 });
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

test('readPlatformConfig takes every value from the environment', () => {
  const config = readPlatformConfig({
    COMPANY_NAME: 'Acme',
    BASE_DOMAIN: 'acme.cloud',
    ORG_EMAIL_DOMAINS: 'acme.com, acme.io',
    GITEA_URL: 'http://localhost:3007/',
    GITEA_PUBLIC_URL: 'https://code.acme.cloud/',
    GITEA_ORG: 'Acme',
    AUTHENTIK_URL: 'https://sso.acme.cloud',
    OUTPOST_HOST: '10.0.0.5',
    OUTPOST_PORT: '9100',
    UPSTREAM_HOST: '10.0.0.5',
    DEPLOY_ROOT: '/srv/apps/',
    PORT_RANGE: '9000-9499',
    TIMEZONE: 'Europe/Lisbon',
    MANIFEST_FILENAME: 'acme-app.yaml',
    MANIFEST_FILENAME_ALIASES: 'app.yaml,acme-app.yaml',
  });
  assert.equal(config.companyName, 'Acme');
  assert.equal(config.portalHost, 'portal.acme.cloud');
  assert.deepEqual(config.orgEmailDomains, ['acme.com', 'acme.io']);
  assert.equal(config.emailDomain, 'acme.com');
  assert.equal(config.giteaUrl, 'http://localhost:3007');
  assert.equal(config.giteaHost, 'code.acme.cloud');
  assert.equal(config.authentikHost, 'sso.acme.cloud');
  assert.equal(config.outpostPort, 9100);
  assert.equal(config.deployRoot, '/srv/apps');
  assert.deepEqual(config.portRange, { start: 9000, end: 9499 });
  assert.equal(config.timezone, 'Europe/Lisbon');
  assert.deepEqual(config.manifestAliases, ['app.yaml']);
});

test('legacy variable names still work', () => {
  const config = readPlatformConfig({
    PORTAL_USER_DOMAINS: 'legado.com',
    AUTHENTIK_HOST: 'auth.legado.com',
    AUTHENTIK_OUTPOST_FORWARD_HOST: '10.0.0.9',
    NPM_FORWARD_HOST: '10.0.0.9',
    PUBLIC_BASE_URL: 'https://portal.legado.com',
  });
  assert.deepEqual(config.orgEmailDomains, ['legado.com']);
  assert.equal(config.authentikUrl, 'https://auth.legado.com');
  assert.equal(config.outpostHost, '10.0.0.9');
  assert.equal(config.upstreamHost, '10.0.0.9');
  assert.equal(config.portalHost, 'portal.legado.com');
});

test('parsePortRange falls back on invalid input', () => {
  assert.deepEqual(parsePortRange('8100-8999'), { start: 8100, end: 8999 });
  assert.deepEqual(parsePortRange('9000:9100'), { start: 9000, end: 9100 });
  assert.deepEqual(parsePortRange('abc'), { start: 8100, end: 8999 });
  assert.deepEqual(parsePortRange('9000-8000'), { start: 8100, end: 8999 });
});

test('publicPlatformConfig exposes no secret', () => {
  const summary = publicPlatformConfig(readPlatformConfig({ GITEA_TOKEN: 'secret', GITEA_URL: 'http://localhost:3007' }));
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(summary.gitea_url, 'http://git.cloud.localhost');
  assert.equal(summary.port_range.label, '8100-8999');
  assert.equal('agent_name' in summary, false);
  assert.equal('gitops_repo' in summary, false);
});
