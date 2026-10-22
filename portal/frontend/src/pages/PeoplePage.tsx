import { useEffect, useState } from 'react';
import { CircleUserRound, UserCheck, UserX, UsersRound } from 'lucide-react';
import { GroupsResponse, PeopleResponse, getGroups, getPeople } from '../lib/api';
import { errorMessage, formatDateTime } from '../lib/format';
import { CacheAge, MetricCard, PageHeader, RefreshButton } from '../components/portal';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

// Pessoas e grupos do Authentik (admin), so leitura. Mudar alguem de grupo e no
// proprio Authentik (docs/first-user.md); o portal mostra o que esta la.
export function PeoplePage({ nowMs, authentikUrl }: { nowMs: number; authentikUrl?: string | null }) {
  const [people, setPeople] = useState<PeopleResponse | null>(null);
  const [groups, setGroups] = useState<GroupsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load({ refresh = false } = {}) {
    setError(null);
    setLoading(true);
    try {
      const [nextPeople, nextGroups] = await Promise.all([getPeople({ refresh }), getGroups({ refresh })]);
      setPeople(nextPeople);
      setGroups(nextGroups);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const users = people?.users ?? [];
  const active = users.filter((user) => user.is_active).length;

  return (
    <>
      <PageHeader
        title="Pessoas"
        description={<>
          Usuarios e grupos do Authentik, lidos com uma conta de servico que so le. Para convidar alguem ou mudar
          de grupo, use o Authentik{authentikUrl ? <>{' '}(<a className="text-primary hover:underline" href={`${authentikUrl}/if/admin/#/identity/users`} target="_blank" rel="noreferrer">admin</a>)</> : null}.
        </>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <CacheAge meta={people} nowMs={nowMs} loading={loading} />
          <RefreshButton onClick={() => void load({ refresh: true })} loading={loading} />
        </div>
      </PageHeader>

      <section className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={CircleUserRound} label="Pessoas" value={users.length} />
        <MetricCard icon={UserCheck} label="Ativas" value={active} tone="success" />
        <MetricCard icon={UserX} label="Inativas" value={users.length - active} tone={users.length - active ? 'warning' : 'default'} />
      </section>

      {error ? (
        <Card className="border-red-200 bg-red-50 text-red-950">
          <CardContent className="p-4 text-sm">Erro ao ler o Authentik: {error}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Usuarios</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !people ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : !users.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Nenhum usuario retornado.</div>
          ) : (
            <div className="divide-y">
              {users.map((user) => (
                <div key={user.pk} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px_minmax(0,1.2fr)]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name || user.username}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{user.username}{user.type === 'service_account' ? ' · conta de servico' : ''}</div>
                  </div>
                  <div className="min-w-0 truncate text-muted-foreground">{user.email || '—'}</div>
                  <div>
                    <Badge variant={user.is_active ? 'success' : 'secondary'}>{user.is_active ? 'ativo' : 'inativo'}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {user.groups.length ? user.groups.map((group) => (
                      <Badge key={group} variant="outline">{group}</Badge>
                    )) : <span className="text-xs text-muted-foreground">sem grupo</span>}
                    {user.last_login ? <span className="w-full text-xs text-muted-foreground">ultimo acesso {formatDateTime(user.last_login)}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Grupos</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!groups?.groups.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">{loading ? 'Carregando...' : 'Nenhum grupo retornado.'}</div>
          ) : (
            <div className="divide-y">
              {groups.groups.map((group) => (
                <div key={group.pk} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[220px_1fr]">
                  <div className="flex items-center gap-2">
                    <UsersRound className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{group.name}</span>
                    <span className="text-xs text-muted-foreground">{group.member_count}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {group.members.length ? group.members.map((member) => (
                      <Badge key={member.pk} variant={member.is_active ? 'outline' : 'secondary'} title={member.email || undefined}>
                        {member.name || member.username}
                      </Badge>
                    )) : <span className="text-xs text-muted-foreground">sem membros</span>}
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
