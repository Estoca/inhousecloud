export type User = {
  email: string;
  name: string;
  role: string;
  groups?: string[];
  source?: string;
};

export type AppStatus = {
  slug: string;
  name?: string;
  domain?: string;
  category?: string;
  lifecycle?: 'active' | 'review' | 'disabled' | 'archived';
  description?: string;
  owner_email?: string;
  repo_url?: string;
  target?: string;
  docker_stack?: string;
  port?: number;
  overall_status?: 'healthy' | 'warning' | 'error' | 'unknown';
  runtime?: {
    matched?: boolean;
    container?: {
      state?: string;
      status?: string;
      name?: string;
      docker_stack?: string | null;
      docker_service?: string | null;
      resources?: DockerContainer['resources'];
    };
    stack?: string | null;
    stack_containers?: string[];
    stack_container_details?: {
      name: string;
      image?: string;
      state?: string;
      status?: string;
      ports?: string;
      docker_service?: string | null;
      resources?: DockerContainer['resources'];
    }[];
    resources?: {
      containers_count: number;
      measured_containers_count: number;
      cpu_percent: number;
      memory_usage_bytes: number;
      memory_limit_bytes: number;
      pids: number;
      top_memory_container?: { name: string; docker_service?: string | null; memory_usage_bytes?: number | null } | null;
      top_cpu_container?: { name: string; docker_service?: string | null; cpu_percent?: number | null } | null;
    };
    link_type?: string | null;
  };
  proxy?: {
    matched?: boolean;
    disabled?: boolean;
    inherited?: boolean;
    inherited_from_app_slug?: string | null;
    inherited_from_domain?: string | null;
    host?: { forward_host?: string; forward_port?: number };
    disabled_host?: { forward_host?: string; forward_port?: number };
  };
  health?: { checked?: boolean; ok?: boolean; status?: number; error?: string; url?: string; sso_checked?: boolean; sso_protected?: boolean | null };
};

export type AppStatusMetrics = {
  app_slug: string;
  window_hours: number;
  summary: {
    total: number;
    ok: number;
    failures: number;
    uptime_percent: number | null;
    avg_latency_ms: number | null;
    latest_status: string | null;
    latest_at: string | null;
  };
  pings: {
    id: string;
    created_at: string;
    overall_status: string;
    health_ok: boolean | null;
    health_status: number | null;
    latency_ms: number | null;
  }[];
};

export type DockerContainer = {
  name: string;
  image?: string;
  state?: string;
  status?: string;
  ports?: string;
  docker_stack?: string | null;
  docker_service?: string | null;
  app_link_type?: string | null;
  resources?: {
    cpu_percent?: number | null;
    memory_usage_bytes?: number | null;
    memory_limit_bytes?: number | null;
    memory_percent?: number | null;
    net_io?: string | null;
    block_io?: string | null;
    pids?: number | null;
  } | null;
  app_slug?: string | null;
  category?: string;
  owner_email?: string | null;
};

export type PortalAdmin = {
  id: string;
  email: string;
  name?: string | null;
  role: 'super_admin' | 'admin' | 'viewer';
  active: boolean;
  source: 'env' | 'portal' | string;
  created_at?: string | null;
  modified_at?: string | null;
  deactivated_at?: string | null;
};

export type DiskUsageSnapshot = {
  id: string;
  created_at: string;
  source: string;
  app_slug?: string | null;
  docker_stack?: string | null;
  container_name: string;
  docker_service?: string | null;
  image?: string | null;
  state?: string | null;
  size_writable_bytes?: number | null;
  size_virtual_bytes?: number | null;
};

export type DiskUsageSummary = {
  latest_at?: string | null;
  containers_count: number;
  size_writable_bytes: number;
  size_virtual_bytes: number;
  apps?: {
    app_slug?: string | null;
    containers_count: number;
    size_writable_bytes: number;
    size_virtual_bytes: number;
  }[];
};

export type DiskUsageSchedule = {
  enabled: boolean;
  hour: number;
  minute: number;
  timeZone: string;
  poll_ms: number;
  last_run_at?: string | null;
  last_error?: string | null;
  last_recorded?: number | null;
  running: boolean;
  started: boolean;
};

export type AppDeploy = {
  id: number | null;
  run_number: number | null;
  repo_full_name?: string | null;
  workflow?: string | null;
  name?: string | null;
  title?: string | null;
  event?: string | null;
  branch?: string | null;
  status: string;
  outcome: 'success' | 'failed' | 'cancelled' | 'running' | 'unknown' | string;
  commit_sha?: string | null;
  short_sha?: string | null;
  actor?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  url?: string | null;
  source: string;
};

export type AppDeploys = {
  app_slug: string;
  source: string;
  repo?: string | null;
  available: boolean;
  error?: string | null;
  cached?: boolean;
  fetched_at?: string | null;
  count: number;
  deploys: AppDeploy[];
};

export type PlatformConfig = {
  company_name: string;
  base_domain: string;
  portal_url: string;
  org_email_domains: string[];
  gitea_url: string;
  gitea_org: string;
  authentik_url: string;
  upstream_host: string;
  outpost_host: string;
  outpost_port: number;
  deploy_root: string;
  port_range: { start: number; end: number; label: string };
  timezone: string;
  manifest_filename: string;
  manifest_aliases: string[];
};

export type PlatformService = {
  name: string;
  kind: string;
  healthy: boolean | null;
  detail: string;
  checked_at: string;
  configured?: boolean;
  url?: string | null;
  version?: string | null;
  latency_ms?: number | null;
  container?: string | null;
  state?: string | null;
  databases?: { name: string; size_bytes: number; size: string | null }[];
  total_bytes?: number;
  newest_file?: string | null;
  newest_at?: string | null;
  age_hours?: number | null;
  max_age_hours?: number | null;
  glob?: string | null;
};

// Metadados do cache das telas de status (ver src/status-cache.js):
// o portal serve o que esta no cache e atualiza em segundo plano.
export type CacheMeta = {
  cached?: boolean;
  stale?: boolean;
  generated_at?: string | null;
  age_seconds?: number | null;
  cache_ttl_seconds?: number | null;
  cache_expires_at?: string | null;
};

export type AppsStatusResponse = CacheMeta & {
  source?: string;
  updated_at?: string | null;
  count: number;
  category?: string;
  apps: AppStatus[];
};

export type PlatformStatus = CacheMeta & {
  checked_at: string;
  overall: 'healthy' | 'degraded' | string;
  summary: { total: number; healthy: number; unhealthy: number; unknown: number };
  services: PlatformService[];
  links: { portainer?: string | null; glances?: string | null; gitea?: string | null; authentik?: string | null };
};

export async function getMe(): Promise<User | null> {
  const response = await fetch('/api/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.user;
}

export async function getAppsStatus({ refresh = false, category = 'all' } = {}): Promise<AppsStatusResponse> {
  const params = new URLSearchParams();
  if (refresh) params.set('refresh', '1');
  if (category) params.set('category', category);
  const response = await fetch(`/api/apps-status?${params.toString()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return { ...data, apps: data.apps ?? [] };
}

// Botao Atualizar (admin): reconstroi o status dos apps agora, em vez de esperar
// a atualizacao em segundo plano.
export async function refreshAppsStatus({ category = 'all' } = {}): Promise<AppsStatusResponse> {
  const response = await fetch('/api/apps-status/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return { ...data, apps: data.apps ?? [] };
}

export async function updateAppMetadata(
  slug: string,
  input: { category: string; lifecycle?: string; description?: string; owner_email?: string; repo_url?: string; target?: string; docker_stack?: string },
): Promise<AppStatus> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/metadata`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.app;
}

export async function getAppStatusMetrics(slug: string, { hours = 24 } = {}): Promise<AppStatusMetrics> {
  const params = new URLSearchParams({ hours: String(hours) });
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/status-metrics?${params.toString()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function getAppDeploys(slug: string, { limit = 20 } = {}): Promise<AppDeploys> {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/deploys?${params.toString()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function getPlatformConfig(): Promise<PlatformConfig> {
  const response = await fetch('/api/platform/config');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function getPlatformStatus({ refresh = false } = {}): Promise<PlatformStatus> {
  const params = new URLSearchParams();
  if (refresh) params.set('refresh', '1');
  const response = await fetch(`/api/platform/status?${params.toString()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function refreshPlatformStatus(): Promise<PlatformStatus> {
  const response = await fetch('/api/platform/status/refresh', { method: 'POST' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function getDockerContainers(): Promise<DockerContainer[]> {
  const response = await fetch('/api/runtime/docker');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.containers ?? [];
}

export async function updateDockerMetadata(
  name: string,
  input: { category: string; owner_email?: string },
): Promise<DockerContainer> {
  const response = await fetch(`/api/runtime/docker/${encodeURIComponent(name)}/metadata`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.container;
}

export async function getAdmins(): Promise<PortalAdmin[]> {
  const response = await fetch('/api/admins');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.admins ?? [];
}

export async function createAdmin(input: { email: string; name?: string; role: string }): Promise<PortalAdmin> {
  const response = await fetch('/api/admins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.admin;
}

export async function deactivateAdmin(email: string): Promise<PortalAdmin> {
  const response = await fetch(`/api/admins/${encodeURIComponent(email)}/deactivate`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.admin;
}

export async function getDiskUsageSnapshots(): Promise<{ rows: DiskUsageSnapshot[]; summary: DiskUsageSummary | null; schedule: DiskUsageSchedule | null }> {
  const [snapshotsResponse, scheduleResponse] = await Promise.all([
    fetch('/api/disk-usage-snapshots'),
    fetch('/api/disk-usage-schedule'),
  ]);
  if (!snapshotsResponse.ok) throw new Error(`HTTP ${snapshotsResponse.status}`);
  if (!scheduleResponse.ok) throw new Error(`HTTP ${scheduleResponse.status}`);
  const data = await snapshotsResponse.json();
  const scheduleData = await scheduleResponse.json();
  return {
    rows: data.rows ?? [],
    summary: data.summary ?? null,
    schedule: scheduleData.schedule ?? null,
  };
}

export async function runDiskUsageSnapshot(): Promise<{ recorded: number; summary: DiskUsageSummary | null; schedule?: DiskUsageSchedule | null }> {
  const response = await fetch('/api/disk-usage-snapshots/run', { method: 'POST' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
