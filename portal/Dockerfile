# The portal image (service `portal` of the cloud's docker/compose.yml). install.sh copies
# portal/ into the install directory and builds it. The docker CLI talks to docker-ro, the
# cloud's read-only Docker API, through DOCKER_HOST: the container never gets the socket.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache docker-cli

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
