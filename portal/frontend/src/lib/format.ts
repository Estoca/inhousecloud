import type { AppStatus } from './api';

// Formatacao e rotulos compartilhados pelas paginas do portal.

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
// O portal do InHouseCloud so le: descricao, dono e categoria vivem no company-app.yaml
// de cada app e mudam por push; o servidor responde 405 as rotas de edicao antigas.
export const METADATA_EDITABLE = false;

export type CategoryFilter = 'internal_app' | 'infra' | 'pending_investigation' | 'disabled' | 'all';
export type AppSort = 'status' | 'cpu' | 'memory';

export const categoryValues: CategoryFilter[] = ['internal_app', 'infra', 'pending_investigation', 'disabled', 'all'];

export const categoryTabs: { value: CategoryFilter; label: string }[] = [
  { value: 'internal_app', label: 'Apps' },
  { value: 'infra', label: 'Infra' },
  { value: 'pending_investigation', label: 'Pendentes' },
  { value: 'disabled', label: 'Desativados' },
  { value: 'all', label: 'Todos' },
];

export const categoryOptions = [
  { value: 'internal_app', label: 'App' },
  { value: 'infra', label: 'Infra' },
  { value: 'pending_investigation', label: 'Pendente' },
  { value: 'disabled', label: 'Desativado' },
  { value: 'system_test', label: 'Teste do sistema' },
  { value: 'uncategorized', label: 'Sem categoria' },
];

// Link externo com cara de botao outline (Portainer, Glances).
export const externalLinkButtonClass = 'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground';

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Erro desconhecido';
}

export function categoryLabel(value?: string) {
  return categoryOptions.find((option) => option.value === value)?.label || value || 'Sem categoria';
}

export function statusVariant(status?: string): BadgeVariant {
  if (status === 'healthy') return 'success';
  if (status === 'warning') return 'warning';
  if (status === 'error') return 'destructive';
  return 'secondary';
}

export function lifecycleLabel(lifecycle?: string) {
  if (lifecycle === 'review') return 'Em revisão';
  if (lifecycle === 'disabled') return 'Desativado';
  if (lifecycle === 'archived') return 'Arquivado';
  return 'Ativo';
}

export function lifecycleVariant(lifecycle?: string): BadgeVariant {
  if (lifecycle === 'review') return 'warning';
  return lifecycle === 'active' || !lifecycle ? 'success' : 'secondary';
}

export function formatPercent(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '-';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatBytes(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function deployOutcomeVariant(outcome?: string | null): BadgeVariant {
  if (outcome === 'success') return 'success';
  if (outcome === 'failed') return 'destructive';
  if (outcome === 'running') return 'warning';
  return 'secondary';
}

export function deployOutcomeLabel(outcome?: string | null) {
  if (outcome === 'success') return 'sucesso';
  if (outcome === 'failed') return 'falhou';
  if (outcome === 'running') return 'rodando';
  if (outcome === 'cancelled') return 'cancelado';
  return 'desconhecido';
}

export function formatDateTime(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "atualizado há 2 min": idade do payload servido do cache, a partir de generated_at.
export function formatAge(generatedAt?: string | null, nowMs: number = Date.now()) {
  if (!generatedAt) return null;
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) return null;
  const seconds = Math.max(0, Math.round((nowMs - generated) / 1000));
  if (seconds < 45) return 'atualizado agora';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `atualizado há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `atualizado há ${hours} h${rest ? ` ${String(rest).padStart(2, '0')}` : ''}`;
}

function sortApps(apps: AppStatus[]) {
  const order: Record<string, number> = { error: 0, warning: 1, unknown: 2, healthy: 3 };
  return [...apps].sort((a, b) => {
    const byStatus = (order[a.overall_status ?? 'unknown'] ?? 2) - (order[b.overall_status ?? 'unknown'] ?? 2);
    if (byStatus !== 0) return byStatus;
    return (a.name || a.slug).localeCompare(b.name || b.slug);
  });
}

export function sortAppsBy(apps: AppStatus[], sort: AppSort) {
  if (sort === 'cpu') {
    return [...apps].sort((a, b) => (b.runtime?.resources?.cpu_percent ?? 0) - (a.runtime?.resources?.cpu_percent ?? 0));
  }
  if (sort === 'memory') {
    return [...apps].sort((a, b) => (b.runtime?.resources?.memory_usage_bytes ?? 0) - (a.runtime?.resources?.memory_usage_bytes ?? 0));
  }
  return sortApps(apps);
}
