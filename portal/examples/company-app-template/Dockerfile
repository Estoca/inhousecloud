FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV APP_PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]

