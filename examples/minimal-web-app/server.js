import http from "node:http";

const port = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "minimal-web-app" }));
    return;
  }

  if (req.url === "/me") {
    const email =
      req.headers["x-authentik-email"] ||
      req.headers["x-forwarded-email"] ||
      process.env.LOCAL_AUTH_MOCK_EMAIL ||
      null;
    const name =
      req.headers["x-authentik-name"] ||
      req.headers["x-forwarded-user"] ||
      process.env.LOCAL_AUTH_MOCK_NAME ||
      null;

    res.writeHead(email ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ authenticated: Boolean(email), email, name }));
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Open Company Cloud example\n");
});

server.listen(port, () => {
  console.log(`minimal-web-app listening on ${port}`);
});

