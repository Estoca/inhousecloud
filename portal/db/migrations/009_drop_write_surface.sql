-- Portal viewer: remove the write surface that no longer exists in the code.
--
-- Dropped:
--   - deploy_platform.api_tokens      (tokens per usuario/admin; o portal nao emite mais tokens)
--   - deploy_platform.agent_configs   (agente de deploy com chave OpenAI; removido)
--   - deploy_platform.log_chunks      (nunca populada)
--   - deploy_platform.check_events    (nunca populada)
--   - deploy_platform.apps            (nunca populada; o inventario vive em inventory/apps.json)
--
-- Kept:
--   - deploy_platform.deploy_events   continua como read model: o workflow do repo
--     GitOps (repo de pedidos de deploy) ainda registra pedidos de deploy
--     em POST /api/gitops/deploy-requests com o token de servico do runner.
--   - deploy_platform.app_status_events, app_status_pings, disk_usage_snapshots,
--     app_access_daily_metrics e portal_admins.
--
-- As colunas app_id (FK para apps) nunca foram preenchidas pelo codigo.

BEGIN;

DROP TABLE IF EXISTS deploy_platform.log_chunks;
DROP TABLE IF EXISTS deploy_platform.check_events;

ALTER TABLE deploy_platform.deploy_events DROP COLUMN IF EXISTS app_id;
ALTER TABLE deploy_platform.app_status_events DROP COLUMN IF EXISTS app_id;

DROP TABLE IF EXISTS deploy_platform.apps;
DROP TABLE IF EXISTS deploy_platform.api_tokens;
DROP TABLE IF EXISTS deploy_platform.agent_configs;

COMMIT;
