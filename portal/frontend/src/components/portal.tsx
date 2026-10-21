import type React from 'react';
import { LogOut, RefreshCw, ShieldCheck, UserCircle } from 'lucide-react';
import type { CacheMeta, User } from '../lib/api';
import { formatAge, formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

// Pecas de layout repetidas entre as paginas do portal.

export function PageHeader({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </header>
  );
}

export function RefreshButton({
  onClick,
  loading,
  label = 'Atualizar',
}: {
  onClick: () => void;
  loading: boolean;
  label?: string;
}) {
  return (
    <Button onClick={onClick} disabled={loading} variant="outline">
      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
      {label}
    </Button>
  );
}

export function CacheAge({ meta, nowMs, loading }: { meta?: CacheMeta | null; nowMs: number; loading?: boolean }) {
  const label = formatAge(meta?.generated_at, nowMs);
  if (!label) return null;
  return (
    <span className="text-xs text-muted-foreground" title={meta?.generated_at ? `Gerado em ${formatDateTime(meta.generated_at)}` : undefined}>
      {loading ? 'atualizando...' : `${label}${meta?.stale ? ' · atualizando em segundo plano' : ''}`}
    </span>
  );
}

export function UserSessionCard({ user }: { user: User | null }) {
  if (!user) return null;

  return (
    <div className="mt-auto border-t pt-4">
      <div className="rounded-md border bg-background p-3 shadow-sm">
        <div className="flex min-w-0 items-start gap-2">
          <UserCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 text-xs">
            <div className="truncate font-medium text-foreground">{user.name || user.email}</div>
            <div className="truncate text-muted-foreground">{user.email}</div>
            <div className="mt-2 inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
              <ShieldCheck className="h-3 w-3 shrink-0" />
              <span className="truncate">{user.role}</span>
            </div>
          </div>
        </div>
        <form className="mt-3" method="post" action="/logout">
          <Button className="w-full justify-start" size="sm" variant="ghost" type="submit">
            <LogOut className="h-4 w-4" />
            Sair
          </Button>
        </form>
      </div>
    </div>
  );
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold">{value}</div>
        </div>
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground',
            tone === 'success' && 'bg-emerald-50 text-emerald-700',
            tone === 'warning' && 'bg-amber-50 text-amber-700',
            tone === 'danger' && 'bg-red-50 text-red-700',
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}
