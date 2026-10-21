-- Stores compact app status/health pings for short-window metrics.

CREATE TABLE IF NOT EXISTS deploy_platform.app_status_pings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  app_slug text NOT NULL,
  overall_status text NOT NULL,
  health_ok boolean,
  health_status integer,
  latency_ms integer,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_app_status_pings_app_created
  ON deploy_platform.app_status_pings(app_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_app_status_pings_created
  ON deploy_platform.app_status_pings(created_at DESC);
