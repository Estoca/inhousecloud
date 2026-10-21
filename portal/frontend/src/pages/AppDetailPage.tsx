import { useEffect, useMemo, useState } from 'react';
import { Activity, Boxes, CheckCircle2, CircleAlert, Clock3, ExternalLink, Pencil, Save, Server, XCircle } from 'lucide-react';
import {
  AppDeploys,
  AppStatus,
  AppStatusMetrics,
  DockerContainer,
  getAppDeploys,
  getAppStatusMetrics,
  getDockerContainers,
} from '../lib/api';
import {
  categoryLabel,
  categoryOptions,
  deployOutcomeLabel,
  deployOutcomeVariant,
  errorMessage,
  formatBytes,
  formatDateTime,
  formatPercent,
  statusVariant,
} from '../lib/format';
import { useAppMetadata } from '../lib/useAppMetadata';
import { MetricCard, RefreshButton } from '../components/portal';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';

// Pagina de um app: dados do inventario, runtime Docker, deploys lidos do
// Gitea Actions e historico de pings de health.
export function AppDetailPage({
  app,
  canManage,
  emailDomain,
  giteaHost,
  onBack,
  onAppsChanged,
}: {
  app: AppStatus;
  canManage: boolean;
  emailDomain: string;
  giteaHost: string;
  onBack: () => void;
  onAppsChanged: () => Promise<void>;
}) {
  const [metricsWindow, setMetricsWindow] = useState<24 | 168>(24);
  const [metrics, setMetrics] = useState<AppStatusMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [deploys, setDeploys] = useState<AppDeploys | null>(null);
  const [deploysLoading, setDeploysLoading] = useState(false);
  const [deploysError, setDeploysError] = useState<string | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const metadata = useAppMetadata({
    onSaved: async () => {
      await onAppsChanged();
      if (canManage) void loadContainers();
    },
  });
  const editing = metadata.editingSlug === app.slug;

  async function loadMetrics(hours = metricsWindow) {
    setMetricsError(null);
    setMetricsLoading(true);
    try {
      setMetrics(await getAppStatusMetrics(app.slug, { hours }));
    } catch (loadError) {
      setMetricsError(errorMessage(loadError));
    } finally {
      setMetricsLoading(false);
    }
  }

  async function loadDeploys() {
    setDeploysError(null);
    setDeploysLoading(true);
    try {
      setDeploys(await getAppDeploys(app.slug));
    } catch (loadError) {
      setDeploys(null);
      setDeploysError(errorMessage(loadError));
    } finally {
      setDeploysLoading(false);
    }
  }

  // Lista de containers so para sugerir alvo e stack na edicao da metadata.
  async function loadContainers() {
    try {
      setContainers(await getDockerContainers());
    } catch {
      setContainers([]);
    }
  }

  useEffect(() => {
    metadata.cancel();
    void loadMetrics();
    void loadDeploys();
    if (canManage) void loadContainers();
  }, [app.slug]);

  function changeMetricsWindow(hours: 24 | 168) {
    setMetricsWindow(hours);
    void loadMetrics(hours);
  }

  const dockerStackOptions = useMemo(() => (
    Array.from(new Set(containers.map((container) => container.docker_stack).filter(Boolean) as string[])).sort()
  ), [containers]);

  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            Voltar
          </Button>
          <h1 className="mt-3 text-2xl font-semibold tracking-normal">{app.name || app.slug}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {app.domain || '-'} · {app.owner_email || 'sem dono'}
          </p>
        </div>
        {canManage ? <div className="flex gap-2">
          <Button onClick={() => changeMetricsWindow(24)} variant={metricsWindow === 24 ? 'default' : 'outline'} size="sm">
            24h
          </Button>
          <Button onClick={() => changeMetricsWindow(168)} variant={metricsWindow === 168 ? 'default' : 'outline'} size="sm">
            7 dias
          </Button>
          <RefreshButton
            onClick={() => {
              void loadMetrics();
              void loadDeploys();
            }}
            loading={metricsLoading || deploysLoading}
          />
        </div> : null}
      </header>

      {canManage ? <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={Activity} label="Pings" value={metrics?.summary?.total ?? 0} />
          <MetricCard icon={CheckCircle2} label="Uptime" value={metrics?.summary?.uptime_percent == null ? '-' : `${metrics.summary.uptime_percent}%`} tone="success" />
          <MetricCard icon={CircleAlert} label="Falhas" value={metrics?.summary?.failures ?? 0} tone="danger" />
          <MetricCard icon={Clock3} label="Latencia media" value={metrics?.summary?.avg_latency_ms == null ? '-' : `${metrics.summary.avg_latency_ms}ms`} tone="warning" />
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={Server} label="Containers" value={app.runtime?.resources?.containers_count ?? 0} />
          <MetricCard icon={Activity} label="CPU Docker" value={formatPercent(app.runtime?.resources?.cpu_percent)} />
          <MetricCard icon={Boxes} label="RAM Docker" value={formatBytes(app.runtime?.resources?.memory_usage_bytes)} />
          <MetricCard icon={CircleAlert} label="PIDs" value={app.runtime?.resources?.pids ?? 0} tone="warning" />
        </section>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Uso Docker</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Recursos agregados da stack {app.runtime?.stack || app.docker_stack || app.target || app.slug}.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {!app.runtime?.stack_container_details?.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Nenhum container vinculado para este app.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Container</th>
                      <th className="px-4 py-3 font-medium">Estado</th>
                      <th className="px-4 py-3 font-medium">CPU</th>
                      <th className="px-4 py-3 font-medium">RAM</th>
                      <th className="px-4 py-3 font-medium">PIDs</th>
                      <th className="px-4 py-3 font-medium">Portas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {app.runtime.stack_container_details.map((container) => (
                      <tr key={container.name} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <div className="font-medium">{container.name}</div>
                          <div className="text-xs text-muted-foreground">{container.docker_service || container.image || '-'}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={container.state === 'running' ? 'success' : 'warning'}>{container.state || 'unknown'}</Badge>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{formatPercent(container.resources?.cpu_percent)}</td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {formatBytes(container.resources?.memory_usage_bytes)}
                          {container.resources?.memory_percent == null ? '' : ` (${formatPercent(container.resources.memory_percent)})`}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{container.resources?.pids ?? '-'}</td>
                        <td className="px-4 py-3 font-mono text-xs">{container.ports || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </> : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 border-b sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Dados do app</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Metadata, repositorio e vinculo com Docker.</p>
            {metadata.error ? <p className="mt-1 text-sm text-destructive">Erro ao salvar: {metadata.error}</p> : null}
          </div>
          {editing ? (
            <div className="flex gap-2">
              <Button size="icon" variant="outline" type="button" onClick={() => void metadata.save(app.slug)} disabled={metadata.saving} title="Salvar">
                <Save className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" type="button" onClick={metadata.cancel} disabled={metadata.saving} title="Cancelar">
                <XCircle className="h-4 w-4" />
              </Button>
            </div>
          ) : canManage ? (
            <Button size="icon" variant="ghost" type="button" onClick={() => metadata.start(app)} title="Editar dados do app">
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 p-5 text-sm md:grid-cols-2">
          <div><span className="text-muted-foreground">Slug:</span> <span className="font-mono">{app.slug}</span></div>
          <div><span className="text-muted-foreground">Status atual:</span> <Badge variant={statusVariant(app.overall_status)}>{app.overall_status ?? 'unknown'}</Badge></div>
          <label className="grid gap-1 md:col-span-2">
            <span className="text-muted-foreground">Descrição</span>
            {editing ? (
              <textarea
                className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
                maxLength={280}
                value={metadata.form.description}
                placeholder="Explique em uma frase o que este app faz e para quem."
                onChange={(event) => metadata.update('description', event.target.value)}
              />
            ) : (
              <span>{app.description || 'Sem descrição cadastrada.'}</span>
            )}
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">Categoria</span>
            {editing ? (
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={metadata.form.category}
                onChange={(event) => metadata.update('category', event.target.value)}
              >
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <span>{categoryLabel(app.category)}</span>
            )}
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">Ciclo</span>
            {editing ? (
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={metadata.form.lifecycle}
                onChange={(event) => metadata.update('lifecycle', event.target.value)}
              >
                <option value="active">Ativo</option>
                <option value="review">Em revisão</option>
                <option value="disabled">Desativado</option>
                <option value="archived">Arquivado</option>
              </select>
            ) : (
              <span>{app.lifecycle || 'active'}</span>
            )}
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">Dono</span>
            {editing ? (
              <Input
                value={metadata.form.owner_email}
                placeholder={`dono@${emailDomain}`}
                onChange={(event) => metadata.update('owner_email', event.target.value)}
              />
            ) : (
              <span className="font-mono">{app.owner_email || '-'}</span>
            )}
          </label>
          <label className="grid gap-1 md:col-span-2">
            <span className="text-muted-foreground">Repo</span>
            {editing ? (
              <Input
                value={metadata.form.repo_url}
                placeholder="https://github.com/example-org/repo"
                onChange={(event) => metadata.update('repo_url', event.target.value)}
              />
            ) : (
              <span className="break-all font-mono">{app.repo_url || '-'}</span>
            )}
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">Container principal</span>
            {editing ? (
              <>
                <Input
                  list="docker-container-options"
                  value={metadata.form.target}
                  placeholder="nome-do-container"
                  onChange={(event) => metadata.update('target', event.target.value)}
                />
                <datalist id="docker-container-options">
                  {containers.map((container) => (
                    <option key={container.name} value={container.name} />
                  ))}
                </datalist>
              </>
            ) : (
              <span className="font-mono">{app.target || app.runtime?.container?.name || '-'}</span>
            )}
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">Stack Docker</span>
            {editing ? (
              <>
                <Input
                  list="docker-stack-options"
                  value={metadata.form.docker_stack}
                  placeholder="nome-da-stack"
                  onChange={(event) => metadata.update('docker_stack', event.target.value)}
                />
                <datalist id="docker-stack-options">
                  {dockerStackOptions.map((stack) => (
                    <option key={stack} value={stack} />
                  ))}
                </datalist>
              </>
            ) : (
              <span className="font-mono">{app.docker_stack || app.runtime?.stack || '-'}</span>
            )}
          </label>
          <div><span className="text-muted-foreground">Porta:</span> <span className="font-mono">{app.port ?? '-'}</span></div>
          <div>
            <span className="text-muted-foreground">Vinculo Docker:</span>{' '}
            <Badge variant={app.runtime?.matched ? 'success' : 'warning'}>
              {app.runtime?.matched ? app.runtime.link_type || 'container' : 'pendente'}
            </Badge>
          </div>
          <div className="md:col-span-2">
            <span className="text-muted-foreground">Containers da stack:</span>{' '}
            <span className="font-mono text-xs">{app.runtime?.stack_containers?.length ? app.runtime.stack_containers.join(', ') : '-'}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Deploys (Gitea Actions)</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {deploys?.repo
              ? `Runs de push em main do repo ${deploys.repo}. Ultimo deploy: ${deploys.deploys[0] ? `${deployOutcomeLabel(deploys.deploys[0].outcome)} em ${formatDateTime(deploys.deploys[0].started_at)}` : 'nenhum'}.`
              : 'Historico lido direto do Gitea Actions. O portal nao grava eventos de deploy.'}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {deploysError ? (
            <div className="p-8 text-center text-sm text-destructive">Erro ao carregar deploys: {deploysError}</div>
          ) : deploysLoading && !deploys ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : deploys && !deploys.available ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {deploys.error === 'repo_not_on_gitea'
                ? `Repo fora do ${giteaHost}: sem historico de Gitea Actions.`
                : deploys.error === 'missing_repo_url'
                  ? 'App sem repo_url no inventario; edite a metadata para ligar o repo.'
                  : `Gitea indisponivel: ${deploys.error || 'erro desconhecido'}.`}
            </div>
          ) : !deploys?.deploys.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Nenhuma run de deploy encontrada para este repo.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Quando</th>
                    <th className="px-4 py-3 font-medium">Resultado</th>
                    <th className="px-4 py-3 font-medium">Commit</th>
                    <th className="px-4 py-3 font-medium">Autor</th>
                    <th className="px-4 py-3 font-medium">Duracao</th>
                    <th className="px-4 py-3 font-medium">Run</th>
                  </tr>
                </thead>
                <tbody>
                  {deploys.deploys.map((deploy) => (
                    <tr key={deploy.id ?? deploy.url ?? deploy.commit_sha ?? ''} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(deploy.started_at)}</td>
                      <td className="px-4 py-3"><Badge variant={deployOutcomeVariant(deploy.outcome)}>{deployOutcomeLabel(deploy.outcome)}</Badge></td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-xs">{deploy.short_sha || '-'}</div>
                        <div className="max-w-[320px] truncate text-xs text-muted-foreground">{deploy.title || '-'}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{deploy.actor || '-'}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{deploy.duration_ms == null ? '-' : `${Math.round(deploy.duration_ms / 1000)}s`}</td>
                      <td className="px-4 py-3">
                        {deploy.url ? (
                          <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={deploy.url} target="_blank" rel="noreferrer">
                            #{deploy.run_number ?? deploy.id}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Historico de pings</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Janela de {metrics?.window_hours ?? metricsWindow} horas
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {metricsError ? (
            <div className="p-8 text-center text-sm text-destructive">Erro ao carregar metricas: {metricsError}</div>
          ) : metricsLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : !metrics?.pings?.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Ainda nao ha pings gravados nessa janela.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Quando</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">HTTP</th>
                    <th className="px-4 py-3 font-medium">Latencia</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.pings.map((ping) => (
                    <tr key={ping.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(ping.created_at)}</td>
                      <td className="px-4 py-3"><Badge variant={statusVariant(ping.overall_status)}>{ping.overall_status}</Badge></td>
                      <td className="px-4 py-3">{ping.health_status ?? '-'}</td>
                      <td className="px-4 py-3">{ping.latency_ms == null ? '-' : `${ping.latency_ms}ms`}</td>
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
