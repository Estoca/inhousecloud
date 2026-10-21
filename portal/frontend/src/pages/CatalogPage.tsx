import { useMemo, useState } from 'react';
import { Boxes, Clipboard, Clock3, ExternalLink, Pencil, Save, Search, Users, XCircle } from 'lucide-react';
import type { AppStatus, CacheMeta } from '../lib/api';
import {
  AppSort,
  CategoryFilter,
  categoryLabel,
  categoryOptions,
  categoryTabs,
  lifecycleLabel,
  lifecycleVariant,
  sortAppsBy,
  statusVariant,
} from '../lib/format';
import { useAppMetadata } from '../lib/useAppMetadata';
import { CacheAge, MetricCard, PageHeader, RefreshButton } from '../components/portal';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';

type FilterStatus = 'all' | 'healthy' | 'warning' | 'error' | 'unknown';
type FilterRuntime = 'all' | 'docker' | 'npm' | 'missing';
type DashboardMode = 'table' | 'cards';

// Catalogo de apps: visao de descoberta para qualquer pessoa autenticada; os
// filtros operacionais e a edicao de metadata aparecem so para admin.
export function CatalogPage({
  apps,
  meta,
  loading,
  error,
  nowMs,
  canManage,
  viewerOnly,
  activeCategory,
  emailDomain,
  onCategory,
  onRefresh,
  onOpenApp,
  onAppsChanged,
}: {
  apps: AppStatus[];
  meta: CacheMeta | null;
  loading: boolean;
  error: string | null;
  nowMs: number;
  canManage: boolean;
  viewerOnly: boolean;
  activeCategory: CategoryFilter;
  emailDomain: string;
  onCategory: (category: CategoryFilter) => void;
  onRefresh: () => void;
  onOpenApp: (app: AppStatus) => void;
  onAppsChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [appSort, setAppSort] = useState<AppSort>('status');
  const [dashboardMode, setDashboardMode] = useState<DashboardMode>('cards');
  const [status, setStatus] = useState<FilterStatus>('all');
  const [runtime, setRuntime] = useState<FilterRuntime>('all');
  const metadata = useAppMetadata({ onSaved: onAppsChanged });

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedOwner = ownerFilter.trim().toLowerCase();
    const visibleApps = apps.filter((app) => {
      const haystack = [app.slug, app.name, app.description, app.domain, app.port, app.category, app.lifecycle, app.owner_email].join(' ').toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      if (viewerOnly && app.category !== 'internal_app') return false;
      if (normalizedOwner && String(app.owner_email ?? '').toLowerCase() !== normalizedOwner) return false;
      if (status !== 'all' && (app.overall_status ?? 'unknown') !== status) return false;
      if (runtime === 'docker' && !app.runtime?.matched) return false;
      if (runtime === 'npm' && !app.proxy?.matched) return false;
      if (runtime === 'missing' && app.runtime?.matched && app.proxy?.matched) return false;
      return true;
    });
    return sortAppsBy(visibleApps, appSort);
  }, [appSort, apps, ownerFilter, query, runtime, status, viewerOnly]);

  const loadError = error || metadata.error;

  return (
    <>
      <PageHeader title="Apps" description="Catálogo de aplicativos internos, seus responsáveis e como acessá-los.">
        <div className="flex flex-wrap items-center gap-3">
          <CacheAge meta={meta} nowMs={nowMs} loading={loading} />
          <RefreshButton onClick={onRefresh} loading={loading} />
        </div>
      </PageHeader>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Boxes} label="Apps" value={apps.length} />
        <MetricCard icon={Clipboard} label="Com descrição" value={apps.filter((app) => Boolean(app.description)).length} tone="success" />
        <MetricCard icon={Users} label="Com dono" value={apps.filter((app) => Boolean(app.owner_email)).length} />
        <MetricCard icon={Clock3} label="Em revisão" value={apps.filter((app) => app.lifecycle === 'review').length} tone="warning" />
      </section>

      <Card>
        <CardHeader className="gap-4 border-b md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>Inventario</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{filtered.length} apps visiveis</p>
          </div>
          <div className="flex rounded-md border p-1">
            <Button type="button" size="sm" variant={dashboardMode === 'table' ? 'default' : 'ghost'} onClick={() => setDashboardMode('table')}>
              Tabela
            </Button>
            <Button type="button" size="sm" variant={dashboardMode === 'cards' ? 'default' : 'ghost'} onClick={() => setDashboardMode('cards')}>
              Cards
            </Button>
          </div>
          <div className="grid gap-2 md:grid-cols-[220px_220px_160px_180px_160px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Buscar app ou domínio"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {canManage ? <Input
              placeholder="Filtrar dono"
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.target.value)}
            /> : null}
            {canManage ? <select className="h-10 rounded-md border bg-background px-3 text-sm" value={status} onChange={(event) => setStatus(event.target.value as FilterStatus)}>
              <option value="all">Todos status</option>
              <option value="healthy">Healthy</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="unknown">Unknown</option>
            </select> : null}
            {canManage ? <select className="h-10 rounded-md border bg-background px-3 text-sm" value={runtime} onChange={(event) => setRuntime(event.target.value as FilterRuntime)}>
              <option value="all">Docker e NPM</option>
              <option value="docker">Docker OK</option>
              <option value="npm">NPM OK</option>
              <option value="missing">Algum match faltando</option>
            </select> : null}
            {canManage ? <select className="h-10 rounded-md border bg-background px-3 text-sm" value={appSort} onChange={(event) => setAppSort(event.target.value as AppSort)}>
              <option value="status">Ordenar: status</option>
              <option value="cpu">Ordenar: CPU</option>
              <option value="memory">Ordenar: RAM</option>
            </select> : null}
          </div>
        </CardHeader>
        <div className="border-b px-6 py-3">
          <div className="flex flex-wrap gap-2">
            {categoryTabs.filter((tab) => canManage || tab.value === 'internal_app').map((tab) => (
              <Button
                key={tab.value}
                onClick={() => {
                  metadata.cancel();
                  onCategory(tab.value);
                }}
                variant={activeCategory === tab.value ? 'default' : 'outline'}
                size="sm"
              >
                {tab.label}
              </Button>
            ))}
          </div>
        </div>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-8 text-center text-sm text-destructive">Erro ao carregar status: {loadError}</div>
          ) : loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : dashboardMode === 'cards' ? (
            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((app) => (
                <button
                  key={app.slug}
                  type="button"
                  onClick={() => onOpenApp(app)}
                  className="rounded-md border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/20"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{app.name || app.slug}</div>
                      <div className="truncate text-xs text-muted-foreground">{app.domain || app.slug}</div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Badge variant={lifecycleVariant(app.lifecycle)}>{lifecycleLabel(app.lifecycle)}</Badge>
                      <Badge variant={statusVariant(app.overall_status)}>{app.overall_status ?? 'unknown'}</Badge>
                    </div>
                  </div>
                  {app.description ? <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{app.description}</p> : <p className="mt-3 text-sm text-muted-foreground">Sem descrição cadastrada.</p>}
                  <div className="mt-4 grid gap-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Dono</span>
                      <span className="truncate font-mono">{app.owner_email || '-'}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">App</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Categoria</th>
                    <th className="px-4 py-3 font-medium">Dono</th>
                    <th className="px-4 py-3 font-medium">Protegido pelo SSO</th>
                    <th className="px-4 py-3 font-medium">Dominio</th>
                    <th className="px-4 py-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((app) => {
                    const editing = metadata.editingSlug === app.slug;
                    return (
                      <tr key={app.slug} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <button
                            className="text-left font-medium text-primary hover:underline"
                            onClick={() => onOpenApp(app)}
                            type="button"
                          >
                            {app.name || app.slug}
                          </button>
                          <div className="text-xs text-muted-foreground">{app.slug}</div>
                          {editing ? (
                            <textarea
                              className="mt-2 min-h-16 w-full min-w-64 rounded-md border bg-background px-2 py-1.5 text-xs"
                              maxLength={280}
                              value={metadata.form.description}
                              placeholder="Descreva em uma frase o que este app faz e para quem."
                              aria-label={`Descrição do app ${app.name || app.slug}`}
                              onChange={(event) => metadata.update('description', event.target.value)}
                            />
                          ) : app.description ? <div className="mt-1 max-w-md text-xs text-muted-foreground">{app.description}</div> : null}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={statusVariant(app.overall_status)}>{app.overall_status ?? 'unknown'}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          {editing ? (
                            <select
                              className="h-9 w-36 rounded-md border bg-background px-2 text-sm"
                              value={metadata.form.category}
                              onChange={(event) => metadata.update('category', event.target.value)}
                            >
                              {categoryOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          ) : (
                            <Badge variant="secondary">{categoryLabel(app.category)}</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {editing ? (
                            <div className="grid gap-2">
                              <Input
                                className="h-9 w-56"
                                placeholder={`dono@${emailDomain}`}
                                value={metadata.form.owner_email}
                                onChange={(event) => metadata.update('owner_email', event.target.value)}
                              />
                              <Input
                                className="h-9 w-56"
                                placeholder="https://github.com/example-org/repo"
                                value={metadata.form.repo_url}
                                onChange={(event) => metadata.update('repo_url', event.target.value)}
                              />
                            </div>
                          ) : (
                            <div className="grid gap-1">
                              <span className="font-mono text-xs text-muted-foreground">{app.owner_email || '-'}</span>
                              <span className="max-w-56 truncate font-mono text-xs text-muted-foreground">{app.repo_url || '-'}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {app.health?.sso_checked ? (
                            <Badge variant={app.health.sso_protected ? 'success' : 'secondary'}>{app.health.sso_protected ? 'Sim' : 'Não'}</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Não verificado</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {app.domain ? (
                            <a className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline" href={`https://${app.domain}`} target="_blank" rel="noreferrer">
                              {app.domain}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {editing ? (
                            <div className="flex justify-end gap-2">
                              <Button size="icon" variant="outline" type="button" onClick={() => void metadata.save(app.slug)} disabled={metadata.saving} title="Salvar">
                                <Save className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" type="button" onClick={metadata.cancel} disabled={metadata.saving} title="Cancelar">
                                <XCircle className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : canManage ? (
                            <Button size="icon" variant="ghost" type="button" onClick={() => metadata.start(app)} title="Editar metadata">
                              <Pencil className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
