-- Adds managed API tokens for Claude/GitHub deploy integrations.

CREATE TABLE IF NOT EXISTS deploy_platform.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  revoked_at timestamptz,
  revoked_at_epoch bigint,

  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  token_last4 text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['events', 'deploy_requests'],
  active boolean NOT NULL DEFAULT true,
  created_by text,
  modified_by text,
  last_used_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_api_tokens_active
  ON deploy_platform.api_tokens(active, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deploy_platform_api_tokens_hash
  ON deploy_platform.api_tokens(token_hash)
  WHERE revoked_at IS NULL;
