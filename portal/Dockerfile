# The portal image (service `portal` of the cloud's docker/compose.yml). install.sh copies
# portal/ into the install directory and builds it. The portal reads Docker over HTTP from
# docker-ro, the cloud's read-only Docker API (DOCKER_HOST): no docker CLI, no socket.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json ./
COPY frontend ./frontend
COPY src ./src
COPY inventory/apps.example.json ./inventory/apps.example.json
COPY db ./db
COPY company-app.yaml ./

RUN npm run build && npm prune --omit=dev

# The image's own user (uid 1000); compose also drops every capability.
USER node

EXPOSE 8080

# Migrations run at boot (src/migrate.js), then the server listens on PORT.
CMD ["node", "src/server.js"]
