import http from 'node:http';

const port = Number.parseInt(process.env.APP_PORT || '3000', 10);
const appName = process.env.APP_NAME || 'Minimal Docker App';
const commitHash = String(process.env.COMMIT_SHA || process.env.GIT_SHA || 'unknown').trim() || 'unknown';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: appName, commit_hash: commitHash }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${appName} is running\n`);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`${appName} listening on ${port}`);
});
