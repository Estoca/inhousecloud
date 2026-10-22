import { AuthentikDirectoryError } from './authentik-directory.js';

// GET /api/people e GET /api/groups: pessoas e grupos do Authentik, so para admin
// (viewer leva 403, anonimo 401). Servidos do cache curto, como as telas de
// status (src/status-cache.js): PEOPLE_CACHE_TTL_SECONDS, padrao 60 s; `?refresh=1`
// busca agora. Sem token configurado: 503 com o que falta.
export function peopleCacheTtlSeconds(env = process.env) {
  const value = Number(env.PEOPLE_CACHE_TTL_SECONDS);
  return Number.isFinite(value) && value > 0 ? value : 60;
}

export function attachPeopleRoutes(app, { auth, directory, swr, ttlSeconds = peopleCacheTtlSeconds() }) {
  const peopleResource = swr('authentik-people', async () => {
    const users = await directory.listUsers();
    return { source: 'authentik', count: users.length, users };
  }, { ttlSeconds });
  const groupsResource = swr('authentik-groups', async () => {
    const groups = await directory.listGroups();
    return { source: 'authentik', count: groups.length, groups };
  }, { ttlSeconds });

  function serve(resource) {
    return async (req, res) => {
      if (!directory.configured) {
        res.status(503).json({
          error: 'authentik_directory_not_configured',
          detail: 'AUTHENTIK_PORTAL_TOKEN is empty: run scripts/first-run.sh (or install.sh --apply --from foundation) to create the ihc-portal service account',
        });
        return;
      }
      try {
        const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
        res.json(await resource.get({}, { refresh }));
      } catch (error) {
        const known = error instanceof AuthentikDirectoryError;
        res.status(502).json({
          error: 'authentik_unavailable',
          detail: known ? error.message : 'Authentik request failed',
        });
      }
    };
  }

  app.get('/api/people', auth.requireAdmin, serve(peopleResource));
  app.get('/api/groups', auth.requireAdmin, serve(groupsResource));
}
