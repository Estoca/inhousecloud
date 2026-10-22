# Seguranca do portal

O portal e um agregador **somente leitura**. Ele nao emite tokens, nao executa
deploy, nao altera proxy, Authentik, banco nem `.env` de app. Esta pagina diz como
ele deve ser exposto e o que ainda aceita escrita.

## Exposicao: so atras do proxy

- O Node escuta em `127.0.0.1` por padrao (`HOST` muda isso). No cloud, o servico
  `portal` de `docker/compose.yml` escuta em `0.0.0.0:8080` dentro do container, sem
  porta publicada no host: so a rede `ihc` alcanca o portal, e as pessoas chegam pelo
  proxy.
- Todo acesso de pessoa chega pelo **Nginx Proxy Manager com forward auth do
  Authentik**. O portal confia nos headers `X-authentik-email`, `X-authentik-name` e
  `X-authentik-groups` **so quando o pedido vem do proxy** (`TRUSTED_PROXY_HOSTS=proxy`:
  o endereco de origem tem que ser um dos que o nome `proxy` resolve). Qualquer
  container de app na rede `ihc` alcanca a porta 8080; um pedido dele com headers
  forjados e anonimo (`401`). O smoke test 22 do cloud prova isso.
- `GET /health` (e `/api/health`) e a unica rota que o proxy libera sem Authentik
  (`location = /health`; o container, o proxy e o instalador usam para healthcheck). A
  resposta nao tem segredo.
- O portal nao tem o socket do Docker: le pelo `docker-ro` (GET numa lista permitida,
  `Env` so com nomes, numa rede interna so dele e do proxy Docker), e nunca recebe a
  senha de admin do proxy nem o token de admin do Authentik ou do Gitea (so o token
  somente leitura do Gitea). O container roda como `node` (uid 1000), sem capabilities.

## Autenticacao das rotas

| Rota | Quem acessa |
|---|---|
| `GET /health`, `GET /api/health` | publico |
| demais `GET /api/*` | qualquer pessoa autenticada pelo Authentik (grupo `ihc-users` ou `ihc-admins`) |
| `POST /api/apps-status/refresh`, `POST /api/platform/status/refresh` | admin (grupo `ihc-admins`) |
| `PATCH /api/apps/:slug/metadata`, `PATCH /api/runtime/docker/:name/metadata` | ninguem: `405 read_only` |
| `/api/admins*`, `/api/disk-usage-*` | super admin |
| `/api/internal/mcp/v1/*` | so o `CATALOG_MCP_TOKEN` (`Authorization: Bearer`); a sessao nao abre |
| `GET /api/platform/status` | tambem o `IHC_PORTAL_API_TOKEN` (`Authorization: Bearer`, so leitura, para agentes; `docs/portal-api.md` do cloud) |

Sem a sessao do Authentik, toda rota `/api` fora da lista publica responde `401`. Um
`Authorization: Bearer` so substitui a sessao em `GET /api/platform/status`, e so com o
`IHC_PORTAL_API_TOKEN`: com esse token, qualquer outra rota responde `403`; token errado,
`401`; portal sem a variavel, `503` nessa rota. O teste `test/auth-matrix.test.js` percorre a
tabela de rotas do Express e garante o `401`; `test/service-token.test.js` garante o `403`
do token em todas as outras.

## O que ainda escreve no portal

- **O proprio portal** grava snapshots de status e disco no Postgres dele, e aplica as
  proprias migracoes no boot.
- **Super admins** gerenciam a tabela `portal_admins` (`/api/admins`).
- O inventario e so leitura (o diretorio `catalog/` montado `:ro`): descricao, dono e
  categoria mudam no `company-app.yaml` do app, por push.

Removidos em 2026-10: tokens por usuario e admin (`/api/me/api-tokens`,
`/api/api-tokens`), `POST /api/events` e `POST /api/apps/:slug/events`,
reconciliacao de NPM/Authentik disparada por evento, executor local de go-live e
o agente LLM com chave OpenAI. Antes disso, qualquer viewer do dominio conseguia
emitir um token e, com `details.deploy`, apontar qualquer dominio para outra porta.

Removidos no ramo `export`: o token de servico do runner (`EVENTS_API_TOKEN`) e as
rotas que ele abria (`/api/gitops/*`, `/api/claude-code/*`), a fila de pedidos de
deploy, a descoberta de repos, as metricas de acesso e o login Google.

## Login

- O Authentik e o unico provider: o portal le a pessoa dos headers da forward auth e
  nao tem login proprio, cookie de sessao nem OAuth. `POST /logout` redireciona para
  `/outpost.goauthentik.io/sign_out`.
- Quem pode entrar: o grupo `ihc-admins` (admin) e o `ihc-users` (viewer), lidos de
  `X-authentik-groups`; super admins de `SUPER_ADMIN_EMAILS`; admins da tabela
  `portal_admins`. No cloud, o dominio do e-mail sozinho nao da acesso
  (`PORTAL_ALLOW_DOMAIN_USERS=false`). Hoje a aplicacao do portal no Authentik esta
  ligada so a `ihc-admins`; abrir para `ihc-users` e decisao do PR 5 do cloud.
