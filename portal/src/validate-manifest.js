import { policyErrors } from './secrets-policy.js';
import { normalizeToolPolicies } from './mcp-policy.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPlatformConfig } from './config.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_AUTH_ENV_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Dominio publico aceito para apps: *.<BASE_DOMAIN>.
function platformDomainPattern(config = readPlatformConfig()) {
  return new RegExp(`^[a-z0-9][a-z0-9.-]*\\.${escapeRegExp(config.baseDomain)}$`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(issues, pathName, message) {
  issues.push({ path: pathName, message });
}

function requiredObject(issues, manifest, key) {
  if (!isObject(manifest[key])) {
    issue(issues, key, 'must be an object');
    return {};
  }
  return manifest[key];
}

function requiredString(issues, object, key, pathName) {
  const value = object[key];
  if (typeof value !== 'string' || value.trim() === '') {
    issue(issues, pathName, 'must be a non-empty string');
    return null;
  }
  return value.trim();
}

function validatePort(issues, value) {
  if (value === 'auto') return 'auto';
  if (Number.isInteger(value) && value >= 1 && value <= 65535) return value;
  issue(issues, 'deploy.port', 'must be "auto" or a TCP port number between 1 and 65535');
  return null;
}

function validPlatformDomain(value) {
  return typeof value === 'string' && platformDomainPattern().test(value.trim());
}

function domainMessage() {
  return `must be a *.${readPlatformConfig().baseDomain} domain`;
}

function validateRedirects(issues, redirects, canonicalDomain) {
  if (redirects === undefined) return [];
  if (!Array.isArray(redirects)) {
    issue(issues, 'deploy.redirects', 'must be an array');
    return [];
  }

  const normalized = [];
  redirects.forEach((redirect, index) => {
    const basePath = `deploy.redirects[${index}]`;
    if (!isObject(redirect)) {
      issue(issues, basePath, 'must be an object');
      return;
    }

    const from = requiredString(issues, redirect, 'from', `${basePath}.from`);
    const to = redirect.to === undefined ? canonicalDomain : requiredString(issues, redirect, 'to', `${basePath}.to`);
    const statusCode = redirect.status_code ?? 301;
    const preservePath = redirect.preserve_path ?? true;

    if (from && !validPlatformDomain(from)) {
      issue(issues, `${basePath}.from`, domainMessage());
    }
    if (to && !validPlatformDomain(to)) {
      issue(issues, `${basePath}.to`, domainMessage());
    }
    if (from && to && from === to) {
      issue(issues, `${basePath}.from`, 'must differ from redirect target');
    }
    if (![301, 302].includes(statusCode)) {
      issue(issues, `${basePath}.status_code`, 'must be 301 or 302');
    }
    if (typeof preservePath !== 'boolean') {
      issue(issues, `${basePath}.preserve_path`, 'must be true or false');
    }

    normalized.push({ from, to, status_code: statusCode, preserve_path: preservePath });
  });

  return normalized;
}

function validateAuth(issues, auth) {
  if (!isObject(auth)) {
    issue(issues, 'auth', 'must be an object');
    return null;
  }

  if (auth.required !== true) {
    issue(issues, 'auth.required', 'must be true for deployable apps');
  }

  if (!['authentik', 'google'].includes(auth.provider)) {
    issue(issues, 'auth.provider', 'must be "authentik" or "google"');
  }

  if (!Array.isArray(auth.allowed_domains) || auth.allowed_domains.length === 0) {
    issue(issues, 'auth.allowed_domains', 'must include at least one allowed domain');
    return auth.provider;
  }

  const orgDomains = readPlatformConfig().orgEmailDomains;
  if (!auth.allowed_domains.some((item) => orgDomains.includes(String(item).toLowerCase()))) {
    issue(issues, 'auth.allowed_domains', `must include ${orgDomains[0]}`);
  }

  return auth.provider;
}

function validateObjectStorage(issues, objectStorage) {
  if (objectStorage === undefined) return;
  if (!isObject(objectStorage)) {
    issue(issues, 'object_storage', 'must be an object');
    return;
  }
  if (typeof objectStorage.required !== 'boolean') {
    issue(issues, 'object_storage.required', 'must be true or false');
  }
  if (objectStorage.required === true && objectStorage.provider !== 'minio') {
    issue(issues, 'object_storage.provider', 'must be "minio" when object storage is required');
  }
  if (objectStorage.bucket !== undefined && objectStorage.bucket !== 'auto' && (typeof objectStorage.bucket !== 'string' || objectStorage.bucket.trim() === '')) {
    issue(issues, 'object_storage.bucket', 'must be "auto" or a non-empty bucket name');
  }
}

function validateDependencies(issues, dependencies) {
  if (dependencies === undefined) return;
  if (!isObject(dependencies)) {
    issue(issues, 'dependencies', 'must be an object');
    return;
  }

  const redis = dependencies.redis;
  if (redis === undefined) return;
  if (typeof redis === 'boolean') return;
  if (!isObject(redis)) {
    issue(issues, 'dependencies.redis', 'must be true, false, or an object');
    return;
  }
  if (typeof redis.required !== 'boolean') {
    issue(issues, 'dependencies.redis.required', 'must be true or false');
  }
  if (redis.required === true && redis.shared !== undefined && redis.shared !== true) {
    issue(issues, 'dependencies.redis.shared', 'must be true for deployable apps unless an exception is approved');
  }
  if (redis.prefix !== undefined && (typeof redis.prefix !== 'string' || redis.prefix.trim() === '')) {
    issue(issues, 'dependencies.redis.prefix', 'must be a non-empty string when provided');
  }
}

// Secao MCP, camada 1 (docs/app-contract.md "MCP" e docs/mcp-gateway.md do cloud): o
// gateway MCP lista GET tools_path e chama POST execute_path no container do app com um
// actor JWT (aud = audience, scope = os escopos concedidos aos grupos de quem pede).
// Mesmas regras de scripts/lib/appmanifest.py (mcp_errors). Aceita `mcp:` no topo ou a
// forma antiga `agent_interface.mcp`; provider, authentication e tools sao opcionais.
const MCP_PATH = /^\/[A-Za-z0-9/_.{}-]*$/;
const MCP_SCOPE = /^[A-Za-z0-9_.:-]{1,128}$/;

function validateMcp(issues, mcp, appSlug, field) {
  if (!isObject(mcp)) {
    issue(issues, field, 'must be an object (audience, tools_path, execute_path, scopes) or be left out');
    return;
  }
  if (mcp.enabled === false) return;
  const audience = mcp.audience ?? `${appSlug}.mcp`;
  if (typeof audience !== 'string' || !audience.startsWith(`${appSlug}.`)) {
    issue(issues, `${field}.audience`, `must start with "${appSlug}." (for example ${appSlug}.mcp)`);
  }
  for (const [key, fallback] of [['tools_path', '/mcp/tools'], ['execute_path', '/mcp/tools/{tool}/execute']]) {
    const value = mcp[key] ?? fallback;
    if (typeof value !== 'string' || !MCP_PATH.test(value) || value.includes('..') || value.startsWith('//')) {
      issue(issues, `${field}.${key}`, `must be a path on the app's container, such as ${fallback}`);
    }
  }
  if (!String(mcp.execute_path ?? '{tool}').includes('{tool}')) issue(issues, `${field}.execute_path`, 'must contain {tool}');
  if (mcp.authentication !== undefined && mcp.authentication !== 'actor_jwt') issue(issues, `${field}.authentication`, 'must be "actor_jwt"');
  let names = [];
  if (Array.isArray(mcp.scopes)) {
    names = mcp.scopes.map((scope) => (isObject(scope) ? scope.name : scope));
  } else if (isObject(mcp.scopes)) {
    names = Object.keys(mcp.scopes);
    for (const [name, groups] of Object.entries(mcp.scopes)) {
      if (!Array.isArray(groups) || groups.length === 0 || !groups.every((group) => typeof group === 'string' && group.trim())) {
        issue(issues, `${field}.scopes.${name}`, 'must list the groups granted this scope, e.g. [ihc-users]');
      }
    }
  }
  if (names.length === 0) issue(issues, `${field}.scopes`, `must grant at least one scope to a group, e.g. ${appSlug}.read: [ihc-users]`);
  for (const name of names) {
    if (typeof name !== 'string' || !MCP_SCOPE.test(name) || !name.startsWith(`${appSlug}.`)) {
      issue(issues, `${field}.scopes`, `${JSON.stringify(name)} must start with "${appSlug}."`);
    }
  }
  // mcp.tools (opcional): por tool, leitura ou escrita e grant a grupos ou pessoas
  // (src/mcp-policy.js). Mesmas regras do gateway: entrada invalida tira o app do gateway.
  if (mcp.tools !== undefined && mcp.tools !== null) {
    for (const problem of normalizeToolPolicies(mcp.tools).problems) issue(issues, `${field}.tools`, problem);
  }
}

function validateEnvExampleAuthVars(issues, envExamplePath, provider) {
  if (provider !== 'google') return;

  const content = readFileSync(envExamplePath, 'utf8');
  for (const key of GOOGLE_AUTH_ENV_VARS) {
    const pattern = new RegExp(`^${key}=`, 'm');
    if (!pattern.test(content)) {
      issue(issues, 'deploy.env_example', `must include ${key} for Google login`);
    }
  }
}

function runDockerCompose(rootDir, composeFile, envExample) {
  const env = { ...process.env };
  if (envExample) env.APP_ENV_FILE = envExample;

  const common = {
    cwd: rootDir,
    env,
    encoding: 'utf8',
    timeout: 30000,
  };

  const composeArgs = ['compose', '-f', composeFile];
  if (envExample) composeArgs.push('--env-file', envExample);

  const config = spawnSync('docker', [...composeArgs, 'config', '--quiet'], common);
  if (config.error?.code === 'ENOENT') {
    return { skipped: true, reason: 'docker command not found' };
  }
  if (config.error) {
    return { ok: false, error: config.error.message };
  }
  if (config.status !== 0) {
    return {
      ok: false,
      error: [config.stderr, config.stdout].filter(Boolean).join('\n').trim() || `docker compose exited with ${config.status}`,
    };
  }

  const services = spawnSync('docker', [...composeArgs, 'config', '--services'], common);
  if (services.status !== 0) {
    return {
      ok: false,
      error: [services.stderr, services.stdout].filter(Boolean).join('\n').trim() || `docker compose services exited with ${services.status}`,
    };
  }

  return {
    ok: true,
    services: services.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
  };
}

export function validateManifest(manifest, options = {}) {
  if (options.staticApp === true) return validateStaticAppManifest(manifest);
  const issues = [];
  const rootDir = options.rootDir ?? process.cwd();
  const skipFileChecks = options.skipFileChecks === true;

  if (!isObject(manifest)) {
    return {
      ok: false,
      issues: [{ path: '$', message: 'manifest must be a YAML object' }],
    };
  }

  if (manifest.schema_version !== 1) {
    issue(issues, 'schema_version', 'must be 1');
  }

  const app = requiredObject(issues, manifest, 'app');
  const runtime = requiredObject(issues, manifest, 'runtime');
  const deploy = requiredObject(issues, manifest, 'deploy');
  const database = isObject(manifest.database) ? manifest.database : {};
  validateObjectStorage(issues, manifest.object_storage);
  validateDependencies(issues, manifest.dependencies);
  const auth = manifest.auth;
  if (manifest.secrets_proxy !== undefined) {
    for (const problem of policyErrors(manifest.secrets_proxy)) issue(issues, 'secrets_proxy', problem);
  }

  const slug = requiredString(issues, app, 'slug', 'app.slug');
  if (slug && !SLUG_RE.test(slug)) {
    issue(issues, 'app.slug', 'must be lowercase alphanumeric with hyphens, 3-64 chars');
  }

  requiredString(issues, app, 'name', 'app.name');
  const ownerEmail = requiredString(issues, app, 'owner_email', 'app.owner_email');
  if (ownerEmail && !EMAIL_RE.test(ownerEmail)) {
    issue(issues, 'app.owner_email', 'must be a valid email');
  }

  const deployEnabled = deploy.enabled !== false;
  const runtimeType = requiredString(issues, runtime, 'type', 'runtime.type');

  if (!deployEnabled) {
    if (!requiredString(issues, deploy, 'reason', 'deploy.reason')) {
      issue(issues, 'deploy.reason', 'is required when deploy.enabled is false');
    }
    return {
      ok: issues.length === 0,
      issues,
      appSlug: slug,
      deployEnabled: false,
    };
  }

  // A secao MCP e opcional (um app sem ela fica fora do gateway); presente, vale o contrato.
  if (manifest.mcp !== undefined) {
    validateMcp(issues, manifest.mcp, slug, 'mcp');
  } else if (manifest.agent_interface !== undefined) {
    if (!isObject(manifest.agent_interface)) issue(issues, 'agent_interface', 'must be an object');
    else if (manifest.agent_interface.mcp !== undefined) validateMcp(issues, manifest.agent_interface.mcp, slug, 'agent_interface.mcp');
  }

  if (runtimeType !== 'docker-compose') {
    issue(issues, 'runtime.type', 'must be "docker-compose" when deploy is enabled');
  }

  const authProvider = validateAuth(issues, auth);

  const composeFile = requiredString(issues, runtime, 'compose_file', 'runtime.compose_file');
  let composePath = null;
  if (composeFile) {
    composePath = path.resolve(rootDir, composeFile);
    if (!skipFileChecks && !existsSync(composePath)) {
      issue(issues, 'runtime.compose_file', `file does not exist: ${composeFile}`);
    }
  }

  const service = requiredString(issues, runtime, 'service', 'runtime.service');

  if (!isObject(runtime.healthcheck)) {
    issue(issues, 'runtime.healthcheck', 'must be an object');
  } else {
    if (runtime.healthcheck.type !== 'http') {
      issue(issues, 'runtime.healthcheck.type', 'must be "http"');
    }
    requiredString(issues, runtime.healthcheck, 'path', 'runtime.healthcheck.path');
    const expectedStatus = runtime.healthcheck.expected_status ?? 200;
    if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
      issue(issues, 'runtime.healthcheck.expected_status', 'must be an HTTP status code');
    }
  }

  const domain = requiredString(issues, deploy, 'domain', 'deploy.domain');
  if (domain && !validPlatformDomain(domain)) {
    issue(issues, 'deploy.domain', domainMessage());
  }
  const redirects = validateRedirects(issues, deploy.redirects, domain);

  const port = validatePort(issues, deploy.port);
  requiredString(issues, deploy, 'env_file', 'deploy.env_file');
  const envExample = requiredString(issues, deploy, 'env_example', 'deploy.env_example');
  if (envExample) {
    const envExamplePath = path.resolve(rootDir, envExample);
    if (skipFileChecks) {
      // The API can validate a submitted YAML without having the repo filesystem.
    } else if (!existsSync(envExamplePath)) {
      issue(issues, 'deploy.env_example', `file does not exist: ${envExample}`);
    } else {
      validateEnvExampleAuthVars(issues, envExamplePath, authProvider);
    }
  }

  if (database.required === true) {
    if (database.engine !== 'postgres') {
      issue(issues, 'database.engine', 'must be "postgres" when database.required is true');
    }
    requiredString(issues, database, 'migrations_command', 'database.migrations_command');
  }

  if (!skipFileChecks && composeFile && composePath && existsSync(composePath) && issues.length === 0) {
    const composeResult = runDockerCompose(rootDir, composeFile, envExample);
    if (composeResult.skipped) {
      issue(issues, 'runtime.compose_file', `could not run docker compose config: ${composeResult.reason}`);
    } else if (!composeResult.ok) {
      issue(issues, 'runtime.compose_file', `docker compose config failed: ${composeResult.error}`);
    } else if (service && !composeResult.services.includes(service)) {
      issue(issues, 'runtime.service', `service not found in compose file: ${service}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    appSlug: slug,
    deployEnabled: true,
    domain,
    port,
    redirects,
  };
}

// Current executor contract (templates/app/company-app.yaml), without Docker, env
// loading, or filesystem access. The older portal form above retains its behavior.
export function validateStaticAppManifest(manifest) {
  const issues = [];
  const get = (key, fallback) => key.split('.').reduce((v, k) => v?.[k], manifest) ?? fallback;
  const requireValue = (key, predicate, message) => { if (!predicate(get(key))) issue(issues, key, message); };
  if (!isObject(manifest)) return { ok: false, issues: [{ path: '$', message: 'manifest must be a YAML object' }] };
  validateStaticSchema(STATIC_APP_SCHEMA, manifest, '$', issues);
  requireValue('schema_version', v => v === 1, 'must be 1');
  requireValue('app.slug', validAppSlug, 'must be an unreserved slug of 3-32 lowercase letters, digits and hyphens');
  requireValue('app.name', v => typeof v === 'string' && !!v.trim(), 'must be a non-empty string');
  requireValue('app.owner_email', v => typeof v === 'string' && EMAIL_RE.test(v), 'must be an email');
  requireValue('runtime.type', v => v === 'docker-compose', 'must be docker-compose');
  requireValue('deploy.enabled', v => v === true, 'must be true');
  if (get('deploy.port', 'auto') !== 'auto') issue(issues, 'deploy.port', 'must be auto');
  if (get('deploy.domain') && !String(get('deploy.domain')).startsWith(`${get('app.slug')}.`)) issue(issues, 'deploy.domain', 'must start with the app slug followed by a dot');
  const port = get('runtime.port', 8080), status = get('runtime.healthcheck.expected_status', 200);
  if (!Number.isInteger(port) || port < 1 || port > 65535) issue(issues, 'runtime.port', 'must be a TCP port');
  if (!Number.isInteger(status) || status < 100 || status > 599) issue(issues, 'runtime.healthcheck.expected_status', 'must be an HTTP status');
  if (get('runtime.healthcheck.type', 'http') !== 'http' || !/^\/[A-Za-z0-9/_.-]*$/.test(get('runtime.healthcheck.path', ''))) issue(issues, 'runtime.healthcheck', 'must be http with a path such as /health');
  if (get('auth.required') !== true || get('auth.provider') !== 'forward-auth') issue(issues, 'auth', 'must require forward-auth company sign-in');
  if (manifest.secrets_proxy !== undefined) for (const problem of policyErrors(manifest.secrets_proxy)) issue(issues, 'secrets_proxy', problem);
  if (manifest.mcp !== undefined) validateMcp(issues, manifest.mcp, get('app.slug'), 'mcp');
  else if (manifest.agent_interface?.mcp !== undefined) validateMcp(issues, manifest.agent_interface.mcp, get('app.slug'), 'agent_interface.mcp');
  return { ok: issues.length === 0, issues, appSlug: get('app.slug') };
}

// The packaged schema uses this deliberately small JSON Schema vocabulary. Keeping
// it here avoids adding a runtime AJV dependency to the gateway image. A contract
// test checks the packaged schema against schemas/company-app.schema.json.
const STATIC_APP_SCHEMA = JSON.parse(readFileSync(new URL('./ihapp-manifest-schema.json', import.meta.url), 'utf8'));
function validateStaticSchema(schema, value, key, issues) {
  if (schema.$ref) schema = STATIC_APP_SCHEMA.$defs[schema.$ref.split('/').at(-1)];
  if (schema.anyOf || schema.oneOf) {
    const branches = schema.anyOf ?? schema.oneOf;
    const count = branches.filter(branch => { const failures = []; validateStaticSchema(branch, value, key, failures); return failures.length === 0; }).length;
    if (count === 0 || (schema.oneOf && count !== 1)) issue(issues, key, 'does not match the manifest schema alternatives');
    return;
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) issue(issues, key, `must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) issue(issues, key, 'must be one of the manifest schema values');
  const types = { object: isObject, array: Array.isArray, integer: Number.isInteger, boolean: v => typeof v === 'boolean', string: v => typeof v === 'string' };
  if (schema.type && !types[schema.type](value)) { issue(issues, key, `must be ${schema.type}`); return; }
  if (typeof value === 'string') {
    if ((schema.minLength && value.length < schema.minLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.format === 'email' && !EMAIL_RE.test(value))) issue(issues, key, 'does not match the manifest string constraint');
  }
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) issue(issues, key, 'is outside the manifest numeric range');
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) issue(issues, key, 'requires more items');
    if (schema.items) value.forEach((v, i) => validateStaticSchema(schema.items, v, `${key}[${i}]`, issues));
  } else if (isObject(value)) {
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) issue(issues, key, 'requires more properties');
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) issue(issues, key === '$' ? required : `${key}.${required}`, 'is required');
    for (const [name, item] of Object.entries(value)) {
      const childKey = key === '$' ? name : `${key}.${name}`;
      if (schema.propertyNames) validateStaticSchema(schema.propertyNames, name, childKey, issues);
      if (schema.properties && Object.hasOwn(schema.properties, name)) validateStaticSchema(schema.properties[name], item, childKey, issues);
      else if (schema.additionalProperties === false) issue(issues, childKey, 'is not a supported property');
      else if (isObject(schema.additionalProperties)) validateStaticSchema(schema.additionalProperties, item, childKey, issues);
    }
  }
}

const RESERVED_APP_SLUGS = new Set(('proxy authentik-postgres authentik-server authentik-worker postgres redis gitea portal garage gitea-runner portainer glances wetty secrets-proxy agent docker-ro filebrowser terminal files gitea-deployer cloudflared tailscale backup auth git s3 s3-console ihc authentik www api admin localhost ihc-smoke mcp').split(' '));
export function validAppSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(value) && !RESERVED_APP_SLUGS.has(value) && !/^(?:app|ihc)-/.test(value);
}
