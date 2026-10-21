-- Stores lightweight Docker disk usage snapshots.

CREATE TABLE IF NOT EXISTS deploy_platform.disk_usage_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  source text NOT NULL DEFAULT 'docker_ps_size',
  app_slug text,
  docker_stack text,
  container_name text NOT NULL,
  docker_service text,
  image text,
  state text,
  size_writable_bytes bigint,
  size_virtual_bytes bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_disk_usage_snapshots_created
  ON deploy_platform.disk_usage_snapshots(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_disk_usage_snapshots_app_created
  ON deploy_platform.disk_usage_snapshots(app_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_disk_usage_snapshots_container_created
  ON deploy_platform.disk_usage_snapshots(container_name, created_at DESC);
