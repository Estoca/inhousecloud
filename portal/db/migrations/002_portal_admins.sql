-- Adds database-backed portal access management.

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

CREATE INDEX IF NOT EXISTS idx_deploy_platform_portal_admins_email
  ON deploy_platform.portal_admins(lower(email));

CREATE INDEX IF NOT EXISTS idx_deploy_platform_portal_admins_active
  ON deploy_platform.portal_admins(active, lower(email));
