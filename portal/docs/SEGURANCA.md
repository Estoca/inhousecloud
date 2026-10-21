# Seguranca do portal

O portal e um agregador **somente leitura**. Ele nao emite tokens, nao executa
deploy, nao altera proxy, Authentik, banco nem `.env` de app. Esta pagina diz como
ele deve ser exposto e o que ainda aceita escrita.

## Exposicao: so atras do proxy

- O Node escuta em `127.0.0.1` por padrao (`HOST` muda isso). No container, o
  `docker-compose.prod.yml` define `HOST=0.0.0.0` porque a porta publicada precisa
  disso; a restricao passa a ser a publicacao da porta e o proxy.
- Todo acesso de pessoa chega pelo **Nginx Proxy Manager com forward auth do
  Authentik**. O portal confia nos headers `X-authentik-email`, `X-authentik-name` e
  `X-authentik-groups`. Por isso ele **nunca** pode ficar alcancavel direto na rede,
  sem o proxy na frente: qualquer um que fale HTTP com a porta do portal poderia
  forjar esses headers.
- Na maquina, confira que a porta do portal nao esta exposta para fora do host:
  o `ports:` do compose deve publicar so para o proxy conseguir chegar, e o firewall
  do host nao deve liberar a porta para a rede local.
- `GET /api/health` e a unica rota que o proxy pode liberar sem Authentik (o
  container e o proxy usam para healthcheck). A resposta nao tem segredo.

## Autenticacao das rotas

| Rota | Quem acessa |
|---|---|
| `GET /api/health` | publico |
| demais `GET /api/*` | qualquer pessoa autenticada pelo Authentik (viewer do dominio da empresa ou admin) |
| `PATCH /api/apps/:slug/metadata`, `PATCH /api/runtime/docker/:name/metadata`, `POST /api/apps-status/refresh`, `POST /api/platform/status/refresh` | admin |
| `/api/admins*`, `/api/disk-usage-*` | super admin |
| `/api/internal/mcp/v1/*` | so o `CATALOG_MCP_TOKEN` (`Authorization: Bearer`); a sessao nao abre |

Sem a sessao do Authentik, toda rota `/api` fora da lista publica responde `401`; um
`Authorization: Bearer` nunca substitui a sessao. O teste `test/auth-matrix.test.js` percorre a tabela de rotas do Express e
garante isso.

## O que ainda escreve no portal

- **Admins** editam metadata do inventario (`inventory/apps.json`).
- **O proprio portal** grava snapshots de status e disco no Postgres dele.

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
- Quem pode entrar: super admins de `SUPER_ADMIN_EMAILS`, admins da tabela
  `portal_admins` e, como viewer, qualquer e-mail dos dominios em `ORG_EMAIL_DOMAINS`.
