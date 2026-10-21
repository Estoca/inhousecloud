# Database

The deploy platform should use the existing shared Postgres service, but with an isolated database and user.

Recommended target:

- database: `ihc_platform`
- schema: `deploy_platform`
- user: `ihc_platform`

## Rules

- Do not delete or modify data from other application databases.
- Keep deploy platform history compact: store events, not full snapshots.
- Keep detailed log chunks for 7 days by default.
- Store large logs outside the database only if this becomes necessary later.
- Every table follows the same base model: `id`, `created_at`, `created_at_epoch`, `modified_at`, `modified_at_epoch`, `deleted_at`, and `deleted_at_epoch`. Epoch fields use `bigint` to avoid the 2038 limit.

## Migration

Initial migration:

```bash
psql "$DATABASE_URL" -f db/migrations/001_deploy_platform_schema.sql
```

Apply every file in `db/migrations/` in order. After `009_drop_write_surface.sql`
the schema has only what the read-only portal uses:

- `deploy_platform.deploy_events`: pedidos de deploy do fluxo GitOps antigo. No ramo `export` o portal nao le nem grava esta tabela; ela fica ate uma migracao que a remova.
- `deploy_platform.app_status_events` e `deploy_platform.app_status_pings`: historico de status/health coletado pelo proprio portal.
- `deploy_platform.disk_usage_snapshots`: snapshots diarios de disco.
- `deploy_platform.app_access_daily_metrics`: metricas de acesso do NPM. No ramo `export` o portal nao le nem grava esta tabela.
- `deploy_platform.portal_admins`: admins do portal.

Removidas em `009`: `apps`, `check_events`, `log_chunks` (nunca populadas), `api_tokens` (o portal nao emite mais tokens) e `agent_configs` (o agente LLM com chave OpenAI foi removido).
