import http from 'node:http';

const port = Number.parseInt(process.env.APP_PORT || '3000', 10);
const appName = process.env.APP_NAME || 'Company App Template';
const commitHash = String(process.env.COMMIT_SHA || process.env.GIT_SHA || 'unknown').trim() || 'unknown';

function header(req, name) {
  return String(req.headers[name.toLowerCase()] || '').trim();
}

function currentUser(req) {
  const authentikEmail = header(req, 'x-authentik-email');
  if (authentikEmail) {
    return {
      email: authentikEmail,
      name: header(req, 'x-authentik-name') || header(req, 'x-authentik-username') || authentikEmail,
      source: 'authentik',
    };
  }

  const mockEmail = String(process.env.LOCAL_AUTH_MOCK_EMAIL || '').trim();
  if (process.env.NODE_ENV !== 'production' && mockEmail) {
    return {
      email: mockEmail,
      name: String(process.env.LOCAL_AUTH_MOCK_NAME || mockEmail).trim(),
      source: 'local-mock',
    };
  }

  return null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: appName, commit_hash: commitHash }));
    return;
  }

  if (req.url === '/me') {
    const user = currentUser(req);
    res.writeHead(user ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${appName} is running\n`);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`${appName} listening on ${port}`);
});
