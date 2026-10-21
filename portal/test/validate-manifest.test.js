import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest } from '../src/validate-manifest.js';

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'ihc-portal-'));
}

test('accepts documentation-only project', () => {
  const result = validateManifest({
    schema_version: 1,
    app: {
      slug: 'inhousecloud-portal',
      name: 'InHouseCloud portal',
      owner_email: 'platform@example.com',
    },
    runtime: {
      type: 'documentation',
    },
    deploy: {
      enabled: false,
      reason: 'Projeto sem app deployavel.',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.deployEnabled, false);
});

test('accepts deployable docker compose app', () => {
  const root = tempDir();
  try {
    writeFileSync(path.join(root, '.env.example'), [
      'APP_PORT=3000',
      'GOOGLE_CLIENT_ID=',
      'GOOGLE_CLIENT_SECRET=',
      'GOOGLE_REDIRECT_URI=',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, 'docker-compose.yml'), [
      'services:',
      '  app:',
      '    image: nginx',
      '    env_file:',
      '      - ${APP_ENV_FILE:-.env}',
      '',
    ].join('\n'));

    const result = validateManifest({
      schema_version: 1,
      app: {
        slug: 'exemplo-app',
        name: 'Exemplo App',
        owner_email: 'nome@example.com',
      },
      runtime: {
        type: 'docker-compose',
        compose_file: 'docker-compose.yml',
        service: 'app',
        healthcheck: {
          type: 'http',
          path: '/health',
          expected_status: 200,
        },
      },
      deploy: {
        enabled: true,
        domain: 'exemplo.cloud.localhost',
        port: 'auto',
        env_file: '.env',
        env_example: '.env.example',
      },
      auth: {
        required: true,
        provider: 'google',
        allowed_domains: ['example.com'],
      },
      database: {
        required: true,
        engine: 'postgres',
        migrations_command: 'npm run migrate',
      },
      object_storage: {
        required: true,
        provider: 'minio',
        bucket: 'auto',
      },
      dependencies: {
        redis: {
          required: true,
          shared: true,
          prefix: 'exemplo-app:',
        },
      },
    }, { rootDir: root });

    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    assert.equal(result.deployEnabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid Redis dependency settings', () => {
  const result = validateManifest({
    schema_version: 1,
    app: {
      slug: 'bad-redis',
      name: 'Bad Redis',
      owner_email: 'nome@example.com',
    },
    runtime: {
      type: 'documentation',
    },
    deploy: {
      enabled: false,
      reason: 'Projeto sem app deployavel.',
    },
    dependencies: {
      redis: {
        required: true,
        shared: false,
        prefix: '',
      },
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.path === 'dependencies.redis.shared'));
  assert.ok(result.issues.some((item) => item.path === 'dependencies.redis.prefix'));
});

test('accepts authentik auth without Google env vars', () => {
  const root = tempDir();
  try {
    writeFileSync(path.join(root, '.env.example'), [
      'APP_PORT=3000',
      'AUTH_PROVIDER=authentik',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, 'docker-compose.yml'), [
      'services:',
      '  app:',
      '    image: nginx',
      '',
    ].join('\n'));

    const result = validateManifest({
      schema_version: 1,
      app: {
        slug: 'authentik-app',
        name: 'Authentik App',
        owner_email: 'nome@example.com',
      },
      runtime: {
        type: 'docker-compose',
        compose_file: 'docker-compose.yml',
        service: 'app',
        healthcheck: {
          type: 'http',
          path: '/health',
          expected_status: 200,
        },
      },
      deploy: {
        enabled: true,
        domain: 'authentik-app.cloud.localhost',
        port: 'auto',
        env_file: '.env',
        env_example: '.env.example',
      },
      auth: {
        required: true,
        provider: 'authentik',
        allowed_domains: ['example.com'],
      },
    }, { rootDir: root });

    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts deploy redirects to canonical domain', () => {
  const result = validateManifest({
    schema_version: 1,
    app: {
      slug: 'painel-controle',
      name: 'Torre de Controle',
      owner_email: 'tech@example.com',
    },
    runtime: {
      type: 'docker-compose',
      compose_file: 'docker-compose.yml',
      service: 'app',
      healthcheck: {
        type: 'http',
        path: '/health',
        expected_status: 200,
      },
    },
    deploy: {
      enabled: true,
      domain: 'intranet.cloud.localhost',
      port: 'auto',
      env_file: '.env',
      env_example: '.env.example',
      redirects: [{
        from: 'painel.cloud.localhost',
        status_code: 301,
        preserve_path: true,
      }],
    },
    auth: {
      required: true,
      provider: 'authentik',
      allowed_domains: ['example.com'],
    },
  }, { skipFileChecks: true });

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.deepEqual(result.redirects, [{
    from: 'painel.cloud.localhost',
    to: 'intranet.cloud.localhost',
    status_code: 301,
    preserve_path: true,
  }]);
});

test('rejects invalid deploy redirects', () => {
  const result = validateManifest({
    schema_version: 1,
    app: {
      slug: 'bad-redirect',
      name: 'Bad Redirect',
      owner_email: 'tech@example.com',
    },
    runtime: {
      type: 'docker-compose',
      compose_file: 'docker-compose.yml',
      service: 'app',
      healthcheck: {
        type: 'http',
        path: '/health',
        expected_status: 200,
      },
    },
    deploy: {
      enabled: true,
      domain: 'intranet.cloud.localhost',
      port: 'auto',
      env_file: '.env',
      env_example: '.env.example',
      redirects: [{
        from: 'example.com',
        to: 'intranet.cloud.localhost',
        status_code: 308,
        preserve_path: 'yes',
      }],
    },
    auth: {
      required: true,
      provider: 'authentik',
      allowed_domains: ['example.com'],
    },
  }, { skipFileChecks: true });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.path === 'deploy.redirects[0].from'));
  assert.ok(result.issues.some((item) => item.path === 'deploy.redirects[0].status_code'));
  assert.ok(result.issues.some((item) => item.path === 'deploy.redirects[0].preserve_path'));
});

test('rejects invalid object storage settings', () => {
  const result = validateManifest({
    schema_version: 1,
    app: {
      slug: 'bad-storage',
      name: 'Bad Storage',
      owner_email: 'nome@example.com',
    },
    runtime: {
      type: 'documentation',
    },
    deploy: {
      enabled: false,
      reason: 'Projeto sem app deployavel.',
    },
    object_storage: {
      required: true,
      provider: 's3',
      bucket: '',
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.path === 'object_storage.provider'));
  assert.ok(result.issues.some((item) => item.path === 'object_storage.bucket'));
});

test('rejects deployable app without compose and healthcheck', () => {
  const result = validateManifest({
    schema_version: 1,
    app: {
      slug: 'Bad_App',
      name: 'Bad App',
      owner_email: 'not-an-email',
    },
    runtime: {
      type: 'docker-compose',
    },
      deploy: {
        enabled: true,
        domain: 'bad.example.com',
        port: 99999,
        env_file: '.env',
      },
  }, { rootDir: process.cwd() });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.path === 'app.slug'));
  assert.ok(result.issues.some((item) => item.path === 'runtime.compose_file'));
  assert.ok(result.issues.some((item) => item.path === 'runtime.healthcheck'));
  assert.ok(result.issues.some((item) => item.path === 'deploy.domain'));
  assert.ok(result.issues.some((item) => item.path === 'deploy.port'));
  assert.ok(result.issues.some((item) => item.path === 'deploy.env_example'));
  assert.ok(result.issues.some((item) => item.path === 'auth'));
});

test('CLI resolves the manifest by configured name and aliases when no path is given', async () => {
  const { resolveDefaultManifestPath } = await import('../src/cli.js');
  const { readPlatformConfig } = await import('../src/config.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const root = mkdtempSync(path.join(os.tmpdir(), 'ihc-manifest-alias-'));
  const config = readPlatformConfig({});
  assert.equal(resolveDefaultManifestPath(root, config), path.join(root, 'company-app.yaml'));

  writeFileSync(path.join(root, 'app.yaml'), 'schema_version: 1\n');
  assert.equal(resolveDefaultManifestPath(root, config), path.join(root, 'app.yaml'));

  writeFileSync(path.join(root, 'company-app.yaml'), 'schema_version: 1\n');
  assert.equal(resolveDefaultManifestPath(root, config), path.join(root, 'company-app.yaml'));

  const custom = readPlatformConfig({ MANIFEST_FILENAME: 'acme-app.yaml', MANIFEST_FILENAME_ALIASES: 'app.yaml' });
  assert.equal(resolveDefaultManifestPath(root, custom), path.join(root, 'app.yaml'));
});
