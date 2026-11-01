import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METHODS } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { createGatewayApp } from '../src/mcp-gateway.js';
import { PLATFORM_TOOLS } from '../src/mcp-platform-tools.js';
import { catalogMcpTools } from '../src/catalog-mcp.js';

const portalText = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
const gatewayText = readFileSync(new URL('../mcp-llms.txt', import.meta.url), 'utf8');
const portal = createApp();
// Nenhuma chave e criada no disco, e nenhuma dependencia externa e chamada.
const gateway = createGatewayApp({ signer: {}, verifier: {} });

function toolSignature(tool, schema, access, role) {
  const required = new Set(schema.required ?? []);
  const args = Object.entries(schema.properties ?? {}).map(([name, property]) => (
    `${name}${required.has(name) ? '' : '?'}: ${property.type}`
  ));
  return `${tool.name}(${args.join(', ')}) [${access}; ${role}]`;
}

function documentedTools(text) {
  return [...text.matchAll(/^- (ihc_\w+\([^\n]*?\) \[[^\]\n]+\]):/gm)].map((match) => match[1]).sort();
}

function registeredRoutes(app) {
  // O registry real do Express inclui auth.attachRoutes e attachPeopleRoutes: nao
  // ha uma segunda lista manual de rotas. O fallback do
  // SPA representa GET / (tambem sem build), nao um endpoint da API por URL de tela.
  return app.router.stack.filter((layer) => layer.route).flatMap(({ route }) => {
    if (route.path instanceof RegExp) assert.equal(String(route.path), String(/^(?!\/auth\/).*/));
    const path = route.path instanceof RegExp ? '/' : route.path;
    const methods = Object.keys(route.methods).filter((method) => route.methods[method]);
    const verbs = methods.map((method) => method.toUpperCase()).sort();
    return (JSON.stringify(verbs) === JSON.stringify([...METHODS].sort()) ? ['ALL'] : verbs)
      .map((method) => `${method} ${path}`);
  }).sort();
}

function documentedRoutes(text) {
  return [...text.matchAll(/^- (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL) (\S+) —/gm)]
    .map((match) => `${match[1]} ${match[2]}`).sort();
}

const platformSignatures = PLATFORM_TOOLS.map((tool) => toolSignature(
  tool, tool.inputSchema, tool.annotations.readOnlyHint ? 'read' : 'write', tool.admin ? 'ihc-admins' : 'ihc-users',
));
const catalogSignatures = catalogMcpTools.map((tool) => toolSignature(tool, tool.input_schema, tool.access, 'catalog-token'));

for (const [name, app, text, tools] of [
  ['portal', portal, portalText, [...platformSignatures, ...catalogSignatures]],
  ['gateway', gateway, gatewayText, platformSignatures],
]) {
  test(`${name} llms.txt matches tool names, arguments, read/write and access from the registries`, () => {
    assert.deepEqual(documentedTools(text), tools.sort(), 'update the tool descriptions in llms.txt');
    const mentionedNames = [...new Set(text.match(/\bihc_[a-z]\w*/g))].sort();
    assert.deepEqual(mentionedNames, tools.map((signature) => signature.split('(')[0]).sort(), 'remove obsolete tool references too');
  });

  test(`${name} llms.txt matches registered HTTP routes in both directions`, () => {
    assert.deepEqual(documentedRoutes(text), registeredRoutes(app), 'update the routes in llms.txt');
  });

  test(`${name} serves the exact llms.txt as public text before authentication`, async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/llms.txt`, { redirect: 'manual' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8$/i);
      assert.equal(await response.text(), text);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('the portal proxy leaves only the exact discovery path public alongside health', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const config = execFileSync('bash', ['-c', '. "$1/scripts/lib/sso.sh"; . "$1/scripts/lib/portal-api.sh"; portal_forward_auth_conf', '_', root], { encoding: 'utf8' });
  const location = config.match(/location = \/llms\.txt \{([^}]+)\}/)?.[1];
  assert.ok(location, 'the portal discovery route must bypass forward auth');
  assert.match(location, /proxy_pass \$forward_scheme:\/\/\$server:\$port\$request_uri;/);
  assert.doesNotMatch(location, /auth_request/);
  assert.match(config, /location = \/health \{/);
  assert.match(config, /auth_request\s+\/outpost\.goauthentik\.io\/auth\/nginx;/);
});

test('the shared Docker image includes both static guides', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY .*\bllms\.txt .*\bmcp-llms\.txt \.\/$/m);
});
