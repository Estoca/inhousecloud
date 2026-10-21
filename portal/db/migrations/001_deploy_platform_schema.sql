-- InHouseCloud portal database bootstrap.
-- Intended target database: ihc_platform
-- Intended schema: deploy_platform

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS deploy_platform;

CREATE TABLE IF NOT EXISTS deploy_platform.apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  deleted_at timestamptz,
  deleted_at_epoch bigint,

  slug text NOT NULL UNIQUE,
  name text,
  owner_name text,
  owner_email text,
  repo_owner text,
  repo_name text,
  domain text,
  category text,
  target text,
  port integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS deploy_platform.deploy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  deleted_at timestamptz,
  deleted_at_epoch bigint,

  app_id uuid REFERENCES deploy_platform.apps(id),
  app_slug text NOT NULL,
  repo_full_name text,
  commit_sha text,
  branch text,
  event_type text NOT NULL,
  status text NOT NULL,
  actor text,
  message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS deploy_platform.check_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  deleted_at timestamptz,
  deleted_at_epoch bigint,

  deploy_event_id uuid REFERENCES deploy_platform.deploy_events(id),
  app_id uuid REFERENCES deploy_platform.apps(id),
  app_slug text NOT NULL,
  check_name text NOT NULL,
  check_type text NOT NULL,
  status text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  message text,
  hint text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS deploy_platform.app_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  deleted_at timestamptz,
  deleted_at_epoch bigint,

  app_id uuid REFERENCES deploy_platform.apps(id),
  app_slug text NOT NULL,
  previous_status text,
  current_status text NOT NULL,
  source text NOT NULL,
  message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS deploy_platform.portal_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  deactivated_at timestamptz,
  deactivated_at_epoch bigint,

  email text NOT NULL UNIQUE,
  name text,
  role text NOT NULL DEFAULT 'admin',
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'portal',
  created_by text,
  modified_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS deploy_platform.log_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  modified_at timestamptz NOT NULL DEFAULT now(),
  modified_at_epoch bigint NOT NULL DEFAULT extract(epoch from now())::bigint,
  deleted_at timestamptz,
  deleted_at_epoch bigint,

  deploy_event_id uuid REFERENCES deploy_platform.deploy_events(id),
  check_event_id uuid REFERENCES deploy_platform.check_events(id),
  app_slug text NOT NULL,
  source text NOT NULL,
  level text,
  chunk_order integer NOT NULL DEFAULT 0,
  content text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_apps_slug
  ON deploy_platform.apps(slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deploy_platform_deploy_events_app_created
  ON deploy_platform.deploy_events(app_slug, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deploy_platform_check_events_deploy
  ON deploy_platform.check_events(deploy_event_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deploy_platform_status_events_app_created
  ON deploy_platform.app_status_events(app_slug, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deploy_platform_portal_admins_email
  ON deploy_platform.portal_admins(lower(email));

CREATE INDEX IF NOT EXISTS idx_deploy_platform_portal_admins_active
  ON deploy_platform.portal_admins(active, lower(email));

CREATE INDEX IF NOT EXISTS idx_deploy_platform_log_chunks_expires
  ON deploy_platform.log_chunks(expires_at)
  WHERE deleted_at IS NULL;
