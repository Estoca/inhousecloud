import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 8080);
const slug = process.env.APP_SLUG || "app";

// MCP, layer 1 (docs/app-contract.md, "MCP"; company-app.yaml, section mcp). The
// cloud's MCP gateway calls these two routes on the app's container, with a short
// actor JWT it signs: who asks (email, groups), for this app (aud) and with which
// scopes (scope). The app checks the token against the gateway's public key and
// decides what each tool returns. Add tools to TOOLS; keep them read only.
const MCP = {
  issuer: process.env.IHC_MCP_ISSUER || "",
  jwksUrl: process.env.IHC_MCP_JWKS_URL || "",
  audience: process.env.IHC_MCP_AUDIENCE || `${slug}.mcp`,
  readScope: `${slug}.read`,
};

const TOOLS = {
  ping: {
    scope: MCP.readScope,
    description: `Checks that ${slug} answers, and says who is asking.`,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (actor) => ({ pong: true, app: slug, email: actor.email, groups: actor.groups, at: new Date().toISOString() }),
  },
};

let jwks = { keys: [], fetchedAt: 0 };
async function gatewayKeys(kid) {
  const stale = Date.now() - jwks.fetchedAt > 5 * 60_000;
  const unknown = kid && !jwks.keys.some((key) => key.kid === kid) && Date.now() - jwks.fetchedAt > 30_000;
  if (stale || unknown) {
    const response = await fetch(MCP.jwksUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
    jwks = { keys: (await response.json()).keys || [], fetchedAt: Date.now() };
  }
  return jwks.keys;
}

// The actor JWT: RS256, signed by a key of the gateway's JWKS, iss = IHC_MCP_ISSUER,
// aud = this app's audience, not expired. Returns its claims or null.
async function verifyActor(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (!match || !MCP.issuer || !MCP.jwksUrl) return null;
  try {
    const [h, p, s] = match[1].split(".");
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const claims = JSON.parse(Buffer.from(p, "base64url"));
    if (header.alg !== "RS256") return null;
    const jwk = (await gatewayKeys(header.kid)).find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
    if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return null;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== MCP.issuer || !aud.includes(MCP.audience) || !(claims.exp + 30 > now)) return null;
    return { email: claims.email || claims.sub, groups: claims.groups || [], scopes: String(claims.scope || "").split(" ").filter(Boolean) };
  } catch {
    return null;
  }
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function mcp(req, res, path) {
  const actor = await verifyActor(req);
  if (!actor) return json(res, 401, { error: { code: "invalid_actor_token", message: "a valid actor JWT from the cloud's MCP gateway is required" } });
  const allowed = Object.entries(TOOLS).filter(([, tool]) => actor.scopes.includes(tool.scope));
  if (req.method === "GET" && path === "/mcp/tools") {
    if (allowed.length === 0) return json(res, 403, { error: { code: "tool_access_denied", message: `no scope of ${slug} for ${actor.email}` } });
    return json(res, 200, { tools: allowed.map(([name, tool]) => ({ name, description: tool.description, input_schema: tool.input_schema, access: "read" })) });
  }
  const call = path.match(/^\/mcp\/tools\/([A-Za-z0-9_-]+)\/execute$/);
  if (req.method === "POST" && call) {
    const tool = TOOLS[call[1]];
    if (!tool) return json(res, 404, { error: { code: "tool_not_found", message: `${slug} has no tool ${call[1]}` } });
    if (!actor.scopes.includes(tool.scope)) return json(res, 403, { error: { code: "tool_access_denied", message: `${call[1]} needs the scope ${tool.scope}` } });
    const body = await readBody(req);
    return json(res, 200, { result: await tool.run(actor, body.arguments || {}) });
  }
  return json(res, 404, { error: { code: "not_found" } });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/health") {
    json(res, 200, { ok: true, service: slug });
    return;
  }

  if (path.startsWith("/mcp/")) {
    try {
      await mcp(req, res, path);
    } catch (error) {
      json(res, 500, { error: { code: "internal_error", message: String(error.message || error) } });
    }
    return;
  }

  if (path === "/me") {
    const email =
      req.headers["x-authentik-email"] ||
      process.env.LOCAL_AUTH_MOCK_EMAIL ||
      null;
    const name =
      req.headers["x-authentik-name"] ||
      process.env.LOCAL_AUTH_MOCK_NAME ||
      null;

    json(res, email ? 200 : 401, { authenticated: Boolean(email), email, name });
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`${slug} is running on the company cloud\n`);
});

server.listen(port, () => {
  console.log(`${slug} listening on ${port}`);
});
