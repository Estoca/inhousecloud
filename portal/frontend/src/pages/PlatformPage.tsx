import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, ExternalLink, ServerCog, XCircle } from 'lucide-react';
import { PlatformStatus, getPlatformStatus, refreshPlatformStatus } from '../lib/api';
import { errorMessage, externalLinkButtonClass, formatAge, formatDateTime } from '../lib/format';
import { CacheAge, MetricCard, PageHeader, RefreshButton } from '../components/portal';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

// Saude dos servicos centrais (mesmo JSON de /api/platform/status).
export function PlatformPage({ canManage, nowMs }: { canManage: boolean; nowMs: number }) {
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Admin forca a sondagem no servidor (POST); os demais pedem com ?refresh=1.
  async function load({ refresh = false } = {}) {
    setError(null);
    setLoading(true);
    try {
      setStatus(refresh && canManage ? await refreshPlatformStatus() : await getPlatformStatus({ refresh }));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader
        title="Plataforma"
        description={<>
          Saude dos servicos centrais da maquina, lida de onde cada um vive. O mesmo JSON esta em{' '}
          <a className="font-mono text-primary hover:underline" href="/api/platform/status" target="_blank" rel="noreferrer">/api/platform/status</a>.
        </>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <CacheAge meta={status} nowMs={nowMs} loading={loading} />
          {status?.links?.portainer ? (
            <a className={externalLinkButtonClass} href={status.links.portainer} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Portainer
            </a>
          ) : null}
          {status?.links?.glances ? (
            <a className={externalLinkButtonClass} href={status.links.glances} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Glances
            </a>
          ) : null}
          <RefreshButton onClick={() => void load({ refresh: true })} loading={loading} />
        </div>
      </PageHeader>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={ServerCog} label="Servicos" value={status?.summary.total ?? 0} />
        <MetricCard icon={CheckCircle2} label="Saudaveis" value={status?.summary.healthy ?? 0} tone="success" />
        <MetricCard icon={XCircle} label="Com problema" value={status?.summary.unhealthy ?? 0} tone="danger" />
        <MetricCard icon={CircleAlert} label="Sem checagem" value={status?.summary.unknown ?? 0} tone="warning" />
      </section>

      {error ? (
        <Card className="border-red-200 bg-red-50 text-red-950">
          <CardContent className="p-4 text-sm">Erro ao carregar a plataforma: {error}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Servicos centrais</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {status
              ? `Estado geral: ${status.overall === 'healthy' ? 'saudavel' : 'degradado'} · checado em ${formatDateTime(status.checked_at)}${status.cached ? ` (cache, ${formatAge(status.generated_at, nowMs) ?? 'idade desconhecida'})` : ''}`
              : 'Carregando...'}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !status ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : !status?.services.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Nenhum servico retornado.</div>
          ) : (
            <div className="divide-y">
              {status.services.map((service) => (
                <div key={service.name} className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[220px_130px_1fr_160px]">
                  <div>
                    <div className="font-medium">{service.name}</div>
                    <div className="text-xs text-muted-foreground">{service.kind}</div>
                  </div>
                  <div>
                    <Badge variant={service.healthy === true ? 'success' : service.healthy === false ? 'destructive' : 'secondary'}>
                      {service.healthy === true ? 'ok' : service.healthy === false ? 'problema' : 'sem checagem'}
                    </Badge>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate">{service.detail}</div>
                    {service.databases?.length ? (
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {service.databases.slice(0, 8).map((database) => (
                          <span key={database.name} className="font-mono">{database.name} {database.size ?? ''}</span>
                        ))}
                        {service.databases.length > 8 ? <span>+{service.databases.length - 8}</span> : null}
                      </div>
                    ) : null}
                    {service.newest_file ? (
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{service.newest_file}</div>
                    ) : null}
                    {service.container ? (
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{service.container}{service.state ? ` · ${service.state}` : ''}</div>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground md:text-right">
                    {service.latency_ms != null ? `${service.latency_ms}ms · ` : ''}{formatDateTime(service.checked_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
