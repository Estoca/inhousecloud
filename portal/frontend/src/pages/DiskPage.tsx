import { useEffect, useState } from 'react';
import { Activity, Boxes, Clock3, Server } from 'lucide-react';
import {
  DiskUsageSchedule,
  DiskUsageSnapshot,
  DiskUsageSummary,
  getDiskUsageSnapshots,
  runDiskUsageSnapshot,
} from '../lib/api';
import { errorMessage, formatBytes, formatDateTime } from '../lib/format';
import { MetricCard, PageHeader, RefreshButton } from '../components/portal';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

// Snapshots de disco por container (super admin). O portal so le o Docker.
export function DiskPage() {
  const [snapshots, setSnapshots] = useState<DiskUsageSnapshot[]>([]);
  const [summary, setSummary] = useState<DiskUsageSummary | null>(null);
  const [schedule, setSchedule] = useState<DiskUsageSchedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const result = await getDiskUsageSnapshots();
      setSnapshots(result.rows);
      setSummary(result.summary);
      setSchedule(result.schedule);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function runNow() {
    setError(null);
    setLoading(true);
    try {
      const result = await runDiskUsageSnapshot();
      setSummary(result.summary);
      if (result.schedule) setSchedule(result.schedule);
      await load();
    } catch (runError) {
      setError(errorMessage(runError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader title="Disco" description="Uso de disco por container, coletado do Docker. O portal nao executa nada: so le.">
        <RefreshButton onClick={() => void load()} loading={loading} />
      </PageHeader>

      <Card>
        <CardHeader className="flex flex-col gap-3 border-b sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Disk snapshots</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Coleta leve via Docker para acompanhar uso writable/virtual por container.
            </p>
          </div>
          <RefreshButton onClick={() => void runNow()} loading={loading} label="Rodar agora" />
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          {error ? <div className="text-sm text-destructive">Erro: {error}</div> : null}
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Clock3} label="Ultimo snapshot" value={summary?.latest_at ? formatDateTime(summary.latest_at) : '-'} />
            <MetricCard icon={Server} label="Containers" value={summary?.containers_count ?? 0} />
            <MetricCard icon={Boxes} label="Writable" value={formatBytes(summary?.size_writable_bytes)} />
            <MetricCard icon={Activity} label="Virtual" value={formatBytes(summary?.size_virtual_bytes)} />
          </section>

          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-3 text-sm">
            <Badge variant={schedule?.enabled ? 'success' : 'secondary'}>
              {schedule?.enabled ? 'Agendado' : 'Manual'}
            </Badge>
            <span className="text-muted-foreground">
              {schedule?.enabled
                ? `Diario as ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} (${schedule.timeZone})`
                : 'Coleta automatica desligada'}
            </span>
            <span className="text-muted-foreground">
              Ultimo run: {schedule?.last_run_at ? formatDateTime(schedule.last_run_at) : '-'}
            </span>
            {schedule?.last_error ? (
              <span className="text-destructive">Erro: {schedule.last_error}</span>
            ) : null}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-md border">
              <div className="border-b px-4 py-3 text-sm font-medium">Top apps por writable</div>
              {!summary?.apps?.length ? (
                <div className="p-6 text-sm text-muted-foreground">Nenhum snapshot gravado ainda.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-medium">App</th>
                        <th className="px-4 py-3 font-medium">Containers</th>
                        <th className="px-4 py-3 font-medium">Writable</th>
                        <th className="px-4 py-3 font-medium">Virtual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.apps.slice(0, 10).map((app) => (
                        <tr key={app.app_slug || 'unmapped'} className="border-b last:border-0">
                          <td className="px-4 py-3 font-mono text-xs">{app.app_slug || 'sem app'}</td>
                          <td className="px-4 py-3">{app.containers_count}</td>
                          <td className="px-4 py-3 font-mono text-xs">{formatBytes(app.size_writable_bytes)}</td>
                          <td className="px-4 py-3 font-mono text-xs">{formatBytes(app.size_virtual_bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-md border">
              <div className="border-b px-4 py-3 text-sm font-medium">Ultimos containers coletados</div>
              {loading ? (
                <div className="p-6 text-sm text-muted-foreground">Carregando...</div>
              ) : snapshots.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">Nenhum snapshot gravado ainda.</div>
              ) : (
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 border-b bg-muted text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-medium">Container</th>
                        <th className="px-4 py-3 font-medium">App</th>
                        <th className="px-4 py-3 font-medium">Writable</th>
                        <th className="px-4 py-3 font-medium">Virtual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshots.slice(0, 30).map((row) => (
                        <tr key={row.id} className="border-b last:border-0">
                          <td className="px-4 py-3">
                            <div className="font-medium">{row.container_name}</div>
                            <div className="text-xs text-muted-foreground">{row.docker_stack || row.docker_service || row.state || '-'}</div>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">{row.app_slug || '-'}</td>
                          <td className="px-4 py-3 font-mono text-xs">{formatBytes(row.size_writable_bytes)}</td>
                          <td className="px-4 py-3 font-mono text-xs">{formatBytes(row.size_virtual_bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
