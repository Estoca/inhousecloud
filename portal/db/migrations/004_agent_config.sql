-- Stores deploy agent provider/model/API key configuration.

CREATE TABLE IF NOT EXISTS deploy_platform.agent_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,

  name text NOT NULL UNIQUE,
  provider text NOT NULL,
  model text NOT NULL,
  api_key_ciphertext text,
  api_key_preview text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  modified_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_agent_configs_active
  ON deploy_platform.agent_configs(active, modified_at DESC);
