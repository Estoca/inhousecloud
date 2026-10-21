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

function validateAgentInterface(issues, agentInterface, appSlug) {
  if (!isObject(agentInterface)) {
    issue(issues, 'agent_interface', 'must be an object for deployable apps');
    return;
  }
  const mcp = agentInterface.mcp;
  if (!isObject(mcp)) {
    issue(issues, 'agent_interface.mcp', 'must be an object for deployable apps');
    return;
  }
  if (mcp.provider !== 'mcp-gateway') issue(issues, 'agent_interface.mcp.provider', 'must be "mcp-gateway"');
  if (mcp.tools_path !== '/api/internal/mcp/v1/tools') issue(issues, 'agent_interface.mcp.tools_path', 'must be "/api/internal/mcp/v1/tools"');
  if (mcp.execute_path !== '/api/internal/mcp/v1/tools/{tool}/execute') issue(issues, 'agent_interface.mcp.execute_path', 'must be "/api/internal/mcp/v1/tools/{tool}/execute"');
  if (mcp.authentication !== 'actor_jwt') issue(issues, 'agent_interface.mcp.authentication', 'must be "actor_jwt"');
  if (typeof mcp.audience !== 'string' || !mcp.audience.trim()) issue(issues, 'agent_interface.mcp.audience', 'must be a non-empty provider audience');
  if (!Array.isArray(mcp.scopes) || !mcp.scopes.some((scope) => typeof scope === 'string' && scope.trim())) issue(issues, 'agent_interface.mcp.scopes', 'must include at least one scope');
  if (!Array.isArray(mcp.tools) || mcp.tools.length === 0) {
    issue(issues, 'agent_interface.mcp.tools', 'must declare at least one read tool');
  } else if (!mcp.tools.some((tool) => isObject(tool) && typeof tool.name === 'string' && tool.name.trim() && (tool.access ?? 'read') === 'read')) {
    issue(issues, 'agent_interface.mcp.tools', 'must include a named read tool');
  }
  if (appSlug && typeof mcp.audience === 'string' && !mcp.audience.startsWith(`${appSlug}.`)) {
    issue(issues, 'agent_interface.mcp.audience', 'must be namespaced by app.slug');
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

  // Existing apps use schema_version 1 and predate the mcp-gateway contract.
  // New templates declare it; validate strictly whenever it is present instead of
  // turning a catalog/documentation rollout into a breaking migration.
  if (manifest.agent_interface !== undefined) {
    validateAgentInterface(issues, manifest.agent_interface, slug);
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
