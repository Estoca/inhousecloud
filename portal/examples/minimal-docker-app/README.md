# Minimal Docker App

App minimo para validar o contrato `company-app.yaml`.

## Rodar localmente

```bash
cp .env.example .env
docker compose up --build
```

Healthcheck:

```bash
curl http://localhost:8100/health
```

O `/health` deve retornar JSON com `ok: true` e `commit_hash`, lido de
`COMMIT_SHA`/`GIT_SHA`. O workflow padrao exporta `COMMIT_SHA`; mantenha essa
variavel repassada no `docker-compose.yml`.

## Validar manifesto

```bash
node ../../src/cli.js validate ./company-app.yaml
```
