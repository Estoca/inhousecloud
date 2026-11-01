-- Audit log of the MCP gateway's write tools (docs/security.md, "Writes need a human";
-- src/mcp-audit.js). Written by the gateway, never by an app: apps have no credential for
-- this database. Append-only: the triggers below refuse UPDATE, DELETE and TRUNCATE for
-- every role, the owner included; removing a row means dropping a trigger first, which
-- only the owner (ihc_platform) or a superuser can do.
--
-- The gateway connects as its own role (ihc_mcp_audit, created by install.sh, stage
-- portal), which install.sh grants USAGE on the schema and SELECT, INSERT on this table
-- and nothing else.
--
-- One write is two rows with the same request_id: `requested` before the app is called
-- (no row, no call) and `completed` after, with the status and, when the app returns
-- them, the previous and the new value. A write the gateway refuses is one `refused` row.

CREATE TABLE IF NOT EXISTS deploy_platform.mcp_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('requested', 'completed', 'refused')),
  actor_email text NOT NULL,
  actor_groups text[] NOT NULL DEFAULT '{}',
  client_id text,
  confirmed_by text,
  confirmed_by_input text,
  tool text NOT NULL,
  provider text,
  access text NOT NULL DEFAULT 'write',
  arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text,
  error text,
  previous_value jsonb,
  new_value jsonb,
  target text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_mcp_audit_log_created
  ON deploy_platform.mcp_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_mcp_audit_log_request
  ON deploy_platform.mcp_audit_log(request_id);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_mcp_audit_log_provider_created
  ON deploy_platform.mcp_audit_log(provider, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deploy_platform_mcp_audit_log_actor_created
  ON deploy_platform.mcp_audit_log(actor_email, created_at DESC);

CREATE OR REPLACE FUNCTION deploy_platform.mcp_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'deploy_platform.mcp_audit_log is append-only: % is refused', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS mcp_audit_log_no_change ON deploy_platform.mcp_audit_log;
CREATE TRIGGER mcp_audit_log_no_change
  BEFORE UPDATE OR DELETE ON deploy_platform.mcp_audit_log
  FOR EACH ROW EXECUTE FUNCTION deploy_platform.mcp_audit_log_append_only();

DROP TRIGGER IF EXISTS mcp_audit_log_no_truncate ON deploy_platform.mcp_audit_log;
CREATE TRIGGER mcp_audit_log_no_truncate
  BEFORE TRUNCATE ON deploy_platform.mcp_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION deploy_platform.mcp_audit_log_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON deploy_platform.mcp_audit_log FROM PUBLIC;
