function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pageShell({ title, body, script = '' }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #18202f;
      --muted: #687385;
      --line: #d9dee7;
      --green: #147a4b;
      --green-bg: #e7f6ee;
      --red: #a83434;
      --red-bg: #fae9e8;
      --amber: #936400;
      --amber-bg: #fff3cf;
      --blue: #155bb5;
      --blue-bg: #e8f1ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; }
    .login {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .login-panel {
      width: min(420px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 28px;
      box-shadow: 0 14px 40px rgba(24, 32, 47, 0.08);
    }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
    }
    .muted {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .login-button,
    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font-weight: 650;
      text-decoration: none;
      cursor: pointer;
    }
    .login-button {
      width: 100%;
      margin-top: 18px;
      padding: 0 14px;
    }
    .topbar {
      min-height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .brand {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
    }
    .brand strong {
      font-size: 16px;
      white-space: nowrap;
    }
    .brand span {
      color: var(--muted);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .icon-button {
      width: 38px;
      padding: 0;
    }
    main {
      width: min(1360px, 100%);
      margin: 0 auto;
      padding: 20px 24px 32px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 82px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .metric strong {
      display: block;
      margin-top: 8px;
      font-size: 24px;
      line-height: 1;
    }
    .filters {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 180px 180px;
      gap: 10px;
      margin-bottom: 12px;
    }
    input,
    select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 0 10px;
      font: inherit;
      font-size: 14px;
    }
    .table-wrap {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
    }
    table {
      width: 100%;
      min-width: 960px;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      font-size: 13px;
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      background: #fbfcfd;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
      font-size: 11px;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tr:last-child td { border-bottom: 0; }
    .app-name {
      display: grid;
      gap: 4px;
    }
    .app-name strong { font-size: 14px; }
    .app-name span {
      color: var(--muted);
      font-size: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .pill.healthy { color: var(--green); background: var(--green-bg); }
    .pill.error { color: var(--red); background: var(--red-bg); }
    .pill.warning { color: var(--amber); background: var(--amber-bg); }
    .pill.unknown { color: var(--blue); background: var(--blue-bg); }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .empty,
    .error-state {
      padding: 28px;
      color: var(--muted);
      text-align: center;
    }
    @media (max-width: 820px) {
      .topbar { padding: 0 14px; }
      main { padding: 14px; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filters { grid-template-columns: 1fr; }
      .brand span { display: none; }
    }
  </style>
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

export function renderLogin({ configured }) {
  const loginAction = '<p class="muted">Autenticacao protegida pelo Authentik.</p>';
  const body = `<section class="login">
  <div class="login-panel">
    <h1>InHouseCloud</h1>
    <p class="muted">Acesso restrito a pessoas autorizadas da empresa.</p>
    ${configured
      ? loginAction
      : '<p class="muted">Autenticacao ainda nao esta configurada neste ambiente.</p>'}
  </div>
</section>`;
  return pageShell({ title: 'Entrar - InHouseCloud', body });
}

export function renderDashboard(user) {
  const body = `<header class="topbar">
  <div class="brand">
    <strong>InHouseCloud</strong>
    <span>${escapeHtml(user.email)} - ${escapeHtml(user.role)}</span>
  </div>
  <div class="toolbar">
    <button class="icon-button" id="refresh" title="Atualizar" aria-label="Atualizar">&#8635;</button>
    <form method="post" action="/logout">
      <button class="icon-button" title="Sair" aria-label="Sair">&#9099;</button>
    </form>
  </div>
</header>
<main>
  <section class="summary" aria-label="Resumo">
    <div class="metric"><span>Apps</span><strong id="metric-total">--</strong></div>
    <div class="metric"><span>Healthy</span><strong id="metric-healthy">--</strong></div>
    <div class="metric"><span>Atencao</span><strong id="metric-warning">--</strong></div>
    <div class="metric"><span>Erro</span><strong id="metric-error">--</strong></div>
  </section>
  <section class="filters" aria-label="Filtros">
    <input id="search" type="search" placeholder="Buscar app, dominio ou porta">
    <select id="status-filter">
      <option value="">Todos os status</option>
      <option value="healthy">Healthy</option>
      <option value="warning">Warning</option>
      <option value="error">Error</option>
      <option value="unknown">Unknown</option>
    </select>
    <select id="runtime-filter">
      <option value="">Docker e NPM</option>
      <option value="docker">Docker OK</option>
      <option value="npm">NPM OK</option>
      <option value="missing">Algum match faltando</option>
    </select>
  </section>
  <section class="table-wrap" aria-label="Apps">
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th>Status</th>
          <th>Docker</th>
          <th>NPM</th>
          <th>Health</th>
          <th>Porta</th>
          <th>Dominio</th>
        </tr>
      </thead>
      <tbody id="apps-body">
        <tr><td colspan="7" class="empty">Carregando...</td></tr>
      </tbody>
    </table>
  </section>
</main>`;

  const script = `
const state = { apps: [] };
const body = document.querySelector('#apps-body');
const search = document.querySelector('#search');
const statusFilter = document.querySelector('#status-filter');
const runtimeFilter = document.querySelector('#runtime-filter');

function text(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function statusClass(status) {
  return ['healthy', 'warning', 'error', 'unknown'].includes(status) ? status : 'unknown';
}

function yesNo(value) {
  return value ? '<span class="pill healthy">OK</span>' : '<span class="pill warning">Pendente</span>';
}

function renderMetrics(apps) {
  document.querySelector('#metric-total').textContent = apps.length;
  document.querySelector('#metric-healthy').textContent = apps.filter((app) => app.overall_status === 'healthy').length;
  document.querySelector('#metric-warning').textContent = apps.filter((app) => app.overall_status === 'warning').length;
  document.querySelector('#metric-error').textContent = apps.filter((app) => app.overall_status === 'error').length;
}

function filteredApps() {
  const query = search.value.trim().toLowerCase();
  const status = statusFilter.value;
  const runtime = runtimeFilter.value;
  return state.apps.filter((app) => {
    const haystack = [app.slug, app.name, app.domain, app.port].join(' ').toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (status && app.overall_status !== status) return false;
    if (runtime === 'docker' && !app.runtime?.matched) return false;
    if (runtime === 'npm' && !app.proxy?.matched) return false;
    if (runtime === 'missing' && app.runtime?.matched && app.proxy?.matched) return false;
    return true;
  });
}

function renderTable() {
  const apps = filteredApps();
  renderMetrics(state.apps);
  if (!apps.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Nenhum app encontrado.</td></tr>';
    return;
  }
  body.innerHTML = apps.map((app) => {
    const health = app.health?.checked
      ? (app.health.ok ? '<span class="pill healthy">OK</span>' : '<span class="pill error">Falha</span>')
      : '<span class="pill unknown">Sem check</span>';
    return \`<tr>
      <td><div class="app-name"><strong>\${text(app.name || app.slug)}</strong><span>\${text(app.slug)}</span></div></td>
      <td><span class="pill \${statusClass(app.overall_status)}">\${text(app.overall_status || 'unknown')}</span></td>
      <td>\${yesNo(app.runtime?.matched)}</td>
      <td>\${yesNo(app.proxy?.matched)}</td>
      <td>\${health}</td>
      <td class="mono">\${text(app.port || '')}</td>
      <td class="mono">\${text(app.domain || '')}</td>
    </tr>\`;
  }).join('');
}

async function load() {
  body.innerHTML = '<tr><td colspan="7" class="empty">Carregando...</td></tr>';
  try {
    const response = await fetch('/api/apps-status');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    state.apps = data.apps || [];
    renderTable();
  } catch (error) {
    body.innerHTML = '<tr><td colspan="7" class="error-state">Erro ao carregar status: ' + text(error.message) + '</td></tr>';
  }
}

document.querySelector('#refresh').addEventListener('click', load);
search.addEventListener('input', renderTable);
statusFilter.addEventListener('change', renderTable);
runtimeFilter.addEventListener('change', renderTable);
load();
`;

  return pageShell({ title: 'InHouseCloud', body, script });
}
