import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SERVICES, allowedPrefix, policyErrors, safePath } from './secrets-policy.js';

function privateJson(path) {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('private config required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
// Directory mounts allow atomic replacement to revoke tokens/grants immediately.
export function readProxyConfig(dir) {
  const credentials = privateJson(`${dir}/credentials.json`);
  const callers = readdirSync(`${dir}/callers`).filter((name) => /^[a-z0-9-]+\.json$/.test(name))
    .map((name) => ({ ...privateJson(`${dir}/callers/${name}`), app: name.slice(0, -5) }));
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('invalid credentials');
  for (const [service, value] of Object.entries(credentials)) {
    if (!Object.hasOwn(SERVICES, service) || typeof value !== 'string' || !value || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('invalid credential');
  }
  for (const caller of callers) {
    if (!/^[a-z0-9-]{3,64}$/.test(caller.app) || !/^[a-f0-9]{64}$/.test(caller.token_hash)
        || policyErrors(caller.policy).length) throw new Error('invalid caller');
  }
  if (new Set(callers.map((caller) => caller.token_hash)).size !== callers.length) throw new Error('duplicate caller token');
  return { credentials, callers };
}
function equal(a, b) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}
class ProxyError extends Error {
  constructor(status) { super('proxy error'); this.status = status; }
}
async function limitedBody(stream, limit, keepRequest = false) {
  const chunks = [];
  let size = 0;
  const source = keepRequest ? stream.iterator({ destroyOnReturn: false }) : stream;
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new ProxyError(413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
export function createSecretsProxy({ config = () => readProxyConfig(process.env.SECRETS_PROXY_DIR || '/ihc/secrets-proxy'),
  fetchFn = globalThis.fetch, audit = (line) => console.log(line), timeoutMs = 10_000, maxBytes = 1024 * 1024 } = {}) {
  return async (req, res) => {
    let app = null, service = null, prefix = null, status = 500;
    const method = req.method;
    const finish = (code, body = Buffer.from(JSON.stringify({ error: `proxy_${code}` })), type = 'application/json') => {
      status = code;
      if (code >= 400) res.shouldKeepAlive = false;
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    if (req.url === '/health' && method === 'GET') { finish(200, Buffer.from('{"ok":true}')); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnected = () => controller.abort();
    res.once('close', disconnected);
    const deadline = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new ProxyError(504)), { once: true });
    });
    // The same deadline covers upload, upstream headers and the entire response.
    const bounded = (promise) => Promise.race([promise, deadline]);
    try {
      let current;
      try { current = config(); } catch { finish(503); return; }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const caller = token && current.callers.find((item) => equal(item.token_hash, crypto.createHash('sha256').update(token).digest('hex')));
      if (!caller) { finish(401); return; }
      app = caller.app;
      const match = /^\/([a-z]+)(\/[^?]*)?(\?[^#]*)?$/.exec(req.url);
      if (!match) { finish(400); return; }
      const [, selected, path = '/', query = ''] = match;
      if (!Object.hasOwn(SERVICES, selected)) { finish(404); return; }
      service = selected;
      if (!safePath(path)) { finish(400); return; }
      prefix = allowedPrefix(caller.policy, service, method, path);
      if (!prefix) { finish(403); return; }
      const credential = current.credentials[service];
      if (!credential) { finish(503); return; }
      // Header allowlist excludes caller auth, cookies, Host and forwarding headers.
      const headers = { Authorization: service === 'linear' ? credential : `Bearer ${credential}`,
        Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'InHouseCloud-secrets-proxy' };
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      if (Number(req.headers['content-length']) > maxBytes) { finish(413); return; }
      const body = await bounded(limitedBody(req, maxBytes, true));
      const response = await bounded(fetchFn(`${SERVICES[service]}${path}${query}`, {
        method, headers, body: ['GET', 'HEAD'].includes(method) || !body.length ? undefined : body,
        redirect: 'manual', signal: controller.signal,
      }));
      if (response.status >= 300 && response.status < 400 || response.status >= 500 || response.status === 401 || response.status === 403) {
        await bounded(response.body?.cancel()); finish(502); return;
      }
      if (response.status >= 400) { await bounded(response.body?.cancel()); finish(response.status); return; }
      let data;
      try { data = await bounded(limitedBody(response.body || [], maxBytes)); }
      catch { throw new ProxyError(502); }
      // Even an upstream echo must not disclose a credential or a caller token.
      const sensitive = [...Object.values(current.credentials), token];
      if (sensitive.some((value) => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')].some(encoded => data.includes(Buffer.from(encoded)))) || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
        finish(502); return;
      }
      const type = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      const safeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)
        && !sensitive.some((value) => type.includes(value));
      finish(response.status, data, safeType ? type : 'application/octet-stream');
    } catch (error) {
      finish(controller.signal.aborted ? 504 : error instanceof ProxyError ? error.status : 502);
    } finally {
      clearTimeout(timer);
      res.off('close', disconnected);
      // Never log raw URLs, queries, tokens, bodies, errors or upstream headers.
      audit(JSON.stringify({ app, service, method: /^[A-Z]{1,16}$/.test(method) ? method : null, path_prefix: prefix, status }));
    }
  };
}
export function startSecretsProxy() {
  const server = http.createServer(createSecretsProxy());
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  server.listen(Number(process.env.PORT || 80), process.env.HOST || '0.0.0.0');
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startSecretsProxy();
