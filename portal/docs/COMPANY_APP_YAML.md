# `company-app.yaml` v0

Contrato operacional minimo para apps publicados em `<slug>.<BASE_DOMAIN>` (numa instalacao local, `*.cloud.localhost`).

## Exemplo para app deployavel

```yaml
schema_version: 1

app:
  slug: exemplo-app
  name: Exemplo App
  owner_email: admin@example.com
  description: App interno da empresa.

runtime:
  type: docker-compose
  compose_file: docker-compose.yml
  service: app
  healthcheck:
    type: http
    path: /health
    expected_status: 200

deploy:
  enabled: true
  domain: exemplo.cloud.localhost
  port: auto
  env_file: .env
  env_example: .env.example

auth:
  required: true
  provider: authentik
  allowed_domains:
    - example.com

database:
  required: false
  engine: postgres
  migrations_command: npm run migrate

object_storage:
  required: false
  provider: minio
  bucket: auto

dependencies:
  redis:
    required: false
    shared: true
    prefix: exemplo-app:

checks:
  build_command: docker compose build
  test_command: npm test
```

## Regras obrigatorias

- `schema_version` deve ser `1`.
- `app.slug` deve ser lowercase, com letras, numeros e hifens.
- `app.owner_email` e obrigatorio.
- Apps deployaveis devem usar `runtime.type: docker-compose`.
- Apps deployaveis devem declarar `runtime.compose_file`.
- Apps deployaveis devem declarar `runtime.service`.
- Apps deployaveis devem declarar healthcheck HTTP.
- Apps deployaveis devem declarar `deploy.domain`.
- Apps deployaveis devem usar `deploy.port: auto` ou uma porta numerica.
- Para apps novos, `deploy.port: auto` e o padrao. Portas fixas aprovadas devem usar a faixa operacional `8100-8999`.
- Apps deployaveis devem declarar `deploy.env_file`.
- Apps deployaveis devem declarar `deploy.env_example`.
- O arquivo declarado em `deploy.env_example` deve existir no repo.
- Apps deployaveis devem declarar `auth.required: true`.
- Apps deployaveis devem declarar `auth.provider: authentik` por padrao.
- Apps deployaveis devem permitir usuarios de um dos dominios de `ORG_EMAIL_DOMAINS` (no exemplo, `example.com`).
- Apps que precisam de arquivos devem declarar `object_storage.required: true`, `object_storage.provider: minio` e `object_storage.bucket: auto`.
- Apps que precisam de Redis devem declarar `dependencies.redis.required: true`, usar `dependencies.redis.shared: true` e definir prefixo por app.
- Apps com `auth.provider: google` sao excecao e devem declarar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REDIRECT_URI` no `.env.example`.
- `docker compose config` deve passar usando `APP_ENV_FILE=deploy.env_example`.
- Se `database.required` for `true`, `database.migrations_command` e obrigatorio.

## Redis compartilhado

Apps novos devem pedir Redis somente quando cache/fila for realmente necessario.

```yaml
dependencies:
  redis:
    required: true
    shared: true
    prefix: exemplo-app:
```

O deploy deve receber `REDIS_URL` no `.env` local e o app deve usar DB logico ou prefixo proprio.
Redis local no Compose requer excecao aprovada. Nunca rode `FLUSHALL`, `FLUSHDB` ou
delecoes amplas no Redis compartilhado.

## Politica operacional

- Apps novos devem preferir `deploy.port: auto`.
- Portas fixas aprovadas para apps novos devem ficar em `8100-8999`.
- O diretorio padrao para novos deploys e `<DEPLOY_ROOT>/{owner_email}/{app_slug}`.
- Eventos compactos ficam retidos indefinidamente; logs detalhados ficam por 7 dias por padrao.

## Projeto nao deployavel

Repos de documentacao ou contrato podem declarar:

```yaml
runtime:
  type: documentation

deploy:
  enabled: false
  reason: Projeto sem app deployavel.
```
