# The portal image (service `portal` of the cloud's docker/compose.yml). install.sh copies
# portal/ into the install directory and builds it. The portal reads Docker over HTTP from
# docker-ro, the cloud's read-only Docker API (DOCKER_HOST): no docker CLI, no socket.
FROM node:20-alpine

RUN apk add --no-cache python3 py3-yaml git

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json ./
COPY frontend ./frontend
COPY src ./src
COPY inventory/apps.example.json ./inventory/apps.example.json
COPY db ./db
# install.sh stages these from scripts/lib and templates/app before the build.
COPY .ihc-runtime/ ./
RUN ln -s scripts/lib /app/applint
COPY company-app.yaml llms.txt mcp-llms.txt ./

RUN npm run build && npm prune --omit=dev \
  && mkdir -p /ihc/mcp-keys /ihc/chat \
  && chown node:node /ihc/mcp-keys /ihc/chat && chmod 700 /ihc/mcp-keys /ihc/chat

# The image's own user (uid 1000); compose also drops every capability.
USER node

EXPOSE 8080

# Migrations run at boot (src/migrate.js), then the server listens on PORT. The same image
# runs the MCP gateway (service `mcp`, docs/mcp-gateway.md) with `node src/mcp-gateway.js`;
# its signing key lives in the volume mounted at /ihc/mcp-keys (owned by node here, so a
# new named volume starts with that owner).
CMD ["node", "src/server.js"]
