-- Stores aggregated Nginx Proxy Manager access metrics without raw request logs.

CREATE TABLE IF NOT EXISTS deploy_platform.app_access_daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  modified_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'npm_access_logs',
  app_slug text NOT NULL DEFAULT 'unmapped',
  domain text NOT NULL,
  npm_proxy_host_id integer,
  requests_total integer NOT NULL DEFAULT 0,
  page_requests_total integer NOT NULL DEFAULT 0,
  status_2xx integer NOT NULL DEFAULT 0,
  status_3xx integer NOT NULL DEFAULT 0,
  status_4xx integer NOT NULL DEFAULT 0,
  status_5xx integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (metric_date, source, app_slug, domain, npm_proxy_host_id)
);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_app_access_daily_date
  ON deploy_platform.app_access_daily_metrics(metric_date DESC);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_app_access_daily_app_date
  ON deploy_platform.app_access_daily_metrics(app_slug, metric_date DESC);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_app_access_daily_domain_date
  ON deploy_platform.app_access_daily_metrics(domain, metric_date DESC);
