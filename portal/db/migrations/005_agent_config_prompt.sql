-- Adds editable deploy agent prompt.

ALTER TABLE deploy_platform.agent_configs
  ADD COLUMN IF NOT EXISTS system_prompt text;
