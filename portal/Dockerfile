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

EXPOSE 8006

CMD ["npm", "start"]
