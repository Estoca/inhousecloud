import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Boxes, Contact, HardDrive, Server, ServerCog, Users } from 'lucide-react';
import {
  AppStatus,
  AppsStatusResponse,
  CacheMeta,
  PlatformConfig,
  User,
  getAppsStatus,
  getMe,
  getPlatformConfig,
  refreshAppsStatus,
} from '../lib/api';
import { CategoryFilter, categoryValues, errorMessage } from '../lib/format';
import { cn } from '../lib/utils';
import { UserSessionCard } from '../components/portal';
import { Button } from '../components/ui/button';
import { AdminsPage } from './AdminsPage';
import { AppDetailPage } from './AppDetailPage';
import { CatalogPage } from './CatalogPage';
import { DiskPage } from './DiskPage';
import { DockersPage } from './DockersPage';
import { PeoplePage } from './PeoplePage';
import { PlatformPage } from './PlatformPage';

type View = 'dashboard' | 'app-detail' | 'dockers' | 'platform' | 'people' | 'admins' | 'disk';
type Access = 'all' | 'admin' | 'super_admin';

const viewValues: View[] = ['dashboard', 'app-detail', 'dockers', 'platform', 'people', 'admins', 'disk'];

// Quem ve cada tela; a API aplica a mesma regra (test/auth-matrix.test.js).
const viewAccess: Record<View, Access> = {
  dashboard: 'all',
  'app-detail': 'all',
  dockers: 'admin',
  platform: 'admin',
  people: 'admin',
  disk: 'super_admin',
  admins: 'super_admin',
};

const navGroups: { label: string; items: { label: string; icon: typeof Activity; view: View }[] }[] = [
  {
    label: 'GERAL',
    items: [{ label: 'Dashboard', icon: Activity, view: 'dashboard' }],
  },
  {
    label: 'OPERAÇÃO',
    items: [
      { label: 'Dockers', icon: Server, view: 'dockers' },
      { label: 'Plataforma', icon: ServerCog, view: 'platform' },
      { label: 'Disco', icon: HardDrive, view: 'disk' },
    ],
  },
  {
    label: 'ADMINISTRAÇÃO',
    items: [
      { label: 'Pessoas', icon: Contact, view: 'people' },
      { label: 'Admins', icon: Users, view: 'admins' },
    ],
  },
];

function parseQueryValue<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function canSee(view: View, user: User | null) {
  const access = viewAccess[view];
  if (access === 'all') return true;
  if (access === 'admin') return user?.role === 'admin' || user?.role === 'super_admin';
  return user?.role === 'super_admin';
}

// Casca do portal: identidade, navegacao e a lista de apps (compartilhada entre
// catalogo e pagina do app). Cada pagina carrega os proprios dados.
export function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseQueryValue(searchParams.get('view'), viewValues, 'dashboard');
  const activeCategory = parseQueryValue<CategoryFilter>(searchParams.get('category'), categoryValues, 'internal_app');
  const appSlug = searchParams.get('app') || null;
  const [user, setUser] = useState<User | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [apps, setApps] = useState<AppStatus[]>([]);
  const [appsMeta, setAppsMeta] = useState<CacheMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Relogio para a idade do cache ("atualizado há 2 min") andar sem novo fetch.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const canManage = user?.role === 'admin' || user?.role === 'super_admin';

  function updateLocation(updates: Partial<Record<'view' | 'app' | 'category', string | null>>) {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (value) next.set(key, value);
      else next.delete(key);
    });
    if (next.get('view') !== 'app-detail') next.delete('app');
    setSearchParams(next);
  }

  function showApps(response: AppsStatusResponse) {
    setApps(response.apps);
    setAppsMeta(response);
    setNowMs(Date.now());
  }

  async function load({ refresh = false, category = activeCategory } = {}) {
    setError(null);
    setLoading(true);
    // A navegação depende apenas da identidade; mantenha a coleta mais lenta do
    // inventário em paralelo, sem fazer o menu esperar pelos healthchecks.
    const appsRequest = getAppsStatus({ refresh, category }).then(
      (response) => ({ response, error: null as Error | null }),
      (requestError) => ({ response: null, error: requestError instanceof Error ? requestError : new Error('Erro desconhecido') }),
    );
    try {
      const me = await getMe();
      if (!me) {
        window.location.assign('/login');
        return;
      }
      setUser(me);
      if (!platformConfig) {
        getPlatformConfig().then(setPlatformConfig).catch(() => {});
      }
      const result = await appsRequest;
      if (result.error || !result.response) throw result.error ?? new Error('Erro desconhecido');
      showApps(result.response);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  // Atualizar do catalogo: admin forca a reconstrucao no servidor (POST);
  // viewer pede com ?refresh=1, que faz o mesmo para a visao dele.
  async function refreshApps() {
    if (!canManage) {
      await load({ refresh: true });
      return;
    }
    setError(null);
    setLoading(true);
    try {
      showApps(await refreshAppsStatus({ category: activeCategory }));
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void load();
  }, [activeCategory]);

  function openView(nextView: View) {
    if (!canSee(nextView, user)) return;
    updateLocation({ view: nextView });
  }

  function openCategory(category: CategoryFilter) {
    if (!canManage && category !== 'internal_app') return;
    updateLocation({ view: 'dashboard', category });
  }

  const visibleGroups = navGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => canSee(item.view, user)) }))
    .filter((group) => group.items.length > 0);
  const navItems = visibleGroups.flatMap((group) => group.items);
  const selectedApp = view === 'app-detail' ? apps.find((app) => app.slug === appSlug) ?? null : null;
  const emailDomain = platformConfig?.org_email_domains?.[0] ?? 'empresa.com';
  const giteaHost = platformConfig?.gitea_url ? platformConfig.gitea_url.replace(/^https?:\/\//, '') : 'Gitea';

  function renderPage() {
    if (view === 'app-detail' && appSlug) {
      return selectedApp ? (
        <AppDetailPage
          app={selectedApp}
          canManage={canManage}
          emailDomain={emailDomain}
          giteaHost={giteaHost}
          onBack={() => openView('dashboard')}
          onAppsChanged={() => load({ refresh: true })}
        />
      ) : (
        <div className="p-8 text-center text-sm text-muted-foreground">{loading ? 'Carregando...' : `App ${appSlug} não encontrado.`}</div>
      );
    }
    if (canSee(view, user)) {
      if (view === 'dockers') return <DockersPage emailDomain={emailDomain} />;
      if (view === 'platform') return <PlatformPage canManage={canManage} nowMs={nowMs} />;
      if (view === 'people') return <PeoplePage nowMs={nowMs} authentikUrl={platformConfig?.authentik_url} />;
      if (view === 'disk') return <DiskPage />;
      if (view === 'admins') return <AdminsPage user={user} emailDomain={emailDomain} />;
    }
    return (
      <CatalogPage
        apps={apps}
        meta={appsMeta}
        loading={loading}
        error={error}
        nowMs={nowMs}
        canManage={canManage}
        viewerOnly={user?.role === 'viewer'}
        activeCategory={activeCategory}
        emailDomain={emailDomain}
        onCategory={openCategory}
        onRefresh={() => void refreshApps()}
        onOpenApp={(app) => updateLocation({ view: 'app-detail', app: app.slug })}
        onAppsChanged={() => load({ refresh: true })}
      />
    );
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="sticky top-0 hidden h-screen w-60 flex-col border-r bg-sidebar p-4 text-sidebar-foreground md:flex">
        <div className="mb-8 px-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Boxes className="h-4 w-4 text-primary" />
            InHouseCloud
          </div>
          <div className="mt-1 text-xs text-muted-foreground">Portal de deploy</div>
        </div>
        <nav className="space-y-5">
          {visibleGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              <p className="px-3 text-[10px] font-medium tracking-wider text-muted-foreground">{group.label}</p>
              {group.items.map(({ label, icon: Icon, view: itemView }) => (
                <button
                  key={label}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    view === itemView
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  )}
                  onClick={() => openView(itemView)}
                  type="button"
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <UserSessionCard user={user} />
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
          <nav className="flex gap-2 overflow-x-auto border-b pb-3 md:hidden">
            {navItems.map(({ label, icon: Icon, view: itemView }) => (
              <Button
                key={label}
                onClick={() => openView(itemView)}
                variant={view === itemView ? 'default' : 'outline'}
                size="sm"
                className="shrink-0"
              >
                <Icon className="h-4 w-4" />
                {label}
              </Button>
            ))}
          </nav>
          {renderPage()}
        </div>
      </main>
    </div>
  );
}
