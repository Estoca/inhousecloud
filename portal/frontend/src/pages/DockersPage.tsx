import { useEffect, useMemo, useState } from 'react';
import { Activity, Boxes, CheckCircle2, Pencil, Save, Search, Server, XCircle } from 'lucide-react';
import { DockerContainer, getDockerContainers, updateDockerMetadata } from '../lib/api';
import { CategoryFilter, categoryLabel, categoryOptions, errorMessage, formatBytes, formatPercent } from '../lib/format';
import { MetricCard, PageHeader, RefreshButton } from '../components/portal';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';

type DockerCategoryFilter = CategoryFilter | 'uncategorized';
type DockerStateFilter = 'all' | 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | 'other';

const dockerCategoryTabs: { value: DockerCategoryFilter; label: string }[] = [
  { value: 'internal_app', label: 'Apps' },
  { value: 'infra', label: 'Infra' },
  { value: 'pending_investigation', label: 'Pendentes' },
  { value: 'disabled', label: 'Desativados' },
  { value: 'uncategorized', label: 'Sem categoria' },
  { value: 'all', label: 'Todos' },
];

const dockerStateOptions: { value: DockerStateFilter; label: string }[] = [
  { value: 'all', label: 'Todos os status' },
  { value: 'running', label: 'Rodando' },
  { value: 'exited', label: 'Parados' },
  { value: 'paused', label: 'Pausados' },
  { value: 'restarting', label: 'Reiniciando' },
  { value: 'created', label: 'Criados' },
  { value: 'dead', label: 'Dead' },
  { value: 'other', label: 'Outros' },
];

// Containers da maquina, com categoria operacional e dono (admin).
export function DockersPage({ emailDomain }: { emailDomain: string }) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<DockerCategoryFilter>('internal_app');
  const [stateFilter, setStateFilter] = useState<DockerStateFilter>('all');
  const [query, setQuery] = useState('');
  const [editingContainer, setEditingContainer] = useState<string | null>(null);
  const [metadataForm, setMetadataForm] = useState({ category: 'uncategorized', owner_email: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      setContainers(await getDockerContainers());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function startEdit(container: DockerContainer) {
    setEditingContainer(container.name);
    setMetadataForm({
      category: container.category || 'uncategorized',
      owner_email: container.owner_email || '',
    });
  }

  async function saveMetadata(name: string) {
    setError(null);
    setSaving(true);
    try {
      await updateDockerMetadata(name, metadataForm);
      setEditingContainer(null);
      await load();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  const filteredContainers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return containers.filter((container) => {
      const category = container.category || 'uncategorized';
      const state = container.state || 'unknown';
      const knownState = dockerStateOptions.some((option) => option.value === state);
      const haystack = [
        container.name,
        container.image,
        container.state,
        container.status,
        container.category,
        container.owner_email,
        container.app_slug,
        container.ports,
      ].join(' ').toLowerCase();

      if (categoryFilter !== 'all' && category !== categoryFilter) return false;
      if (stateFilter !== 'all' && stateFilter !== 'other' && state !== stateFilter) return false;
      if (stateFilter === 'other' && knownState) return false;
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      return true;
    });
  }, [containers, categoryFilter, query, stateFilter]);

  const sortedContainers = useMemo(() => {
    return [...filteredContainers].sort((a, b) => {
      const byCategory = (a.category || 'uncategorized').localeCompare(b.category || 'uncategorized');
      if (byCategory !== 0) return byCategory;
      const byState = (a.state || 'unknown').localeCompare(b.state || 'unknown');
      if (byState !== 0) return byState;
      return a.name.localeCompare(b.name);
    });
  }, [filteredContainers]);

  const runningContainers = filteredContainers.filter((container) => container.state === 'running');
  const resourceContainers = runningContainers.filter((container) => container.resources);
  const totalCpuPercent = resourceContainers.reduce((total, container) => total + (container.resources?.cpu_percent ?? 0), 0);
  const totalMemoryBytes = resourceContainers.reduce((total, container) => total + (container.resources?.memory_usage_bytes ?? 0), 0);

  return (
    <>
      <PageHeader title="Dockers" description="Containers, categoria operacional e dono responsavel.">
        <RefreshButton onClick={() => void load()} loading={loading} />
      </PageHeader>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Server} label="Containers" value={filteredContainers.length} />
        <MetricCard icon={CheckCircle2} label="Rodando" value={runningContainers.length} tone="success" />
        <MetricCard icon={Activity} label="CPU" value={formatPercent(totalCpuPercent)} />
        <MetricCard icon={Boxes} label="RAM" value={formatBytes(totalMemoryBytes)} />
      </section>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            {dockerCategoryTabs.map((tab) => (
              <Button
                key={tab.value}
                type="button"
                size="sm"
                variant={categoryFilter === tab.value ? 'default' : 'outline'}
                onClick={() => setCategoryFilter(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_220px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Buscar container, app, imagem, porta ou dono"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as DockerStateFilter)}
            >
              {dockerStateOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Containers</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {filteredContainers.length} de {containers.length} containers encontrados no Docker
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="p-8 text-center text-sm text-destructive">Erro ao carregar Docker: {error}</div>
          ) : loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Container</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Recursos</th>
                    <th className="px-4 py-3 font-medium">Categoria</th>
                    <th className="px-4 py-3 font-medium">Dono</th>
                    <th className="px-4 py-3 font-medium">App</th>
                    <th className="px-4 py-3 font-medium">Portas</th>
                    <th className="px-4 py-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedContainers.map((container) => (
                    <tr key={container.name} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{container.name}</div>
                        <div className="text-xs text-muted-foreground">{container.image || '-'}</div>
                        <div className="text-xs text-muted-foreground">
                          {container.docker_stack ? `${container.docker_stack}${container.docker_service ? ` / ${container.docker_service}` : ''}` : '-'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={container.state === 'running' ? 'success' : 'warning'}>
                          {container.state || 'unknown'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="grid min-w-40 gap-1 text-xs">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">CPU</span>
                            <span className="font-mono">{formatPercent(container.resources?.cpu_percent)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">RAM</span>
                            <span className="font-mono">
                              {formatBytes(container.resources?.memory_usage_bytes)}
                              {container.resources?.memory_percent == null ? '' : ` (${formatPercent(container.resources.memory_percent)})`}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">I/O</span>
                            <span className="font-mono">{container.resources?.block_io || '-'}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {editingContainer === container.name ? (
                          <select
                            className="h-9 w-36 rounded-md border bg-background px-2 text-sm"
                            value={metadataForm.category}
                            onChange={(event) => setMetadataForm((current) => ({ ...current, category: event.target.value }))}
                          >
                            {categoryOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        ) : (
                          <Badge variant="secondary">{categoryLabel(container.category)}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {editingContainer === container.name ? (
                          <Input
                            className="h-9 w-56"
                            placeholder={`dono@${emailDomain}`}
                            value={metadataForm.owner_email}
                            onChange={(event) => setMetadataForm((current) => ({ ...current, owner_email: event.target.value }))}
                          />
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">{container.owner_email || '-'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-xs">{container.app_slug || '-'}</div>
                        <div className="text-xs text-muted-foreground">{container.app_link_type || ''}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{container.ports || '-'}</td>
                      <td className="px-4 py-3 text-right">
                        {editingContainer === container.name ? (
                          <div className="flex justify-end gap-2">
                            <Button size="icon" variant="outline" type="button" onClick={() => void saveMetadata(container.name)} disabled={saving} title="Salvar">
                              <Save className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" type="button" onClick={() => setEditingContainer(null)} disabled={saving} title="Cancelar">
                              <XCircle className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <Button size="icon" variant="ghost" type="button" onClick={() => startEdit(container)} title="Editar metadata">
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
