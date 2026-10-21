// A API do Docker por HTTP, sem o CLI. No cloud, DOCKER_HOST aponta para docker-ro
// (tcp://docker-ro:2375), a API so leitura do cloud: o container do portal nunca tem o
// socket. So GETs que a lista do docker-ro permite: /containers/json (com all e size) e
// /containers/ID/stats?stream=0. O CLI nao serve: `docker stats` abre /events, que o
// docker-ro recusa e registra.
//
// Fora do cloud, sem DOCKER_HOST, fala com /var/run/docker.sock.

import http from 'node:http';

export function dockerEndpoint(env = process.env) {
  const value = typeof env.DOCKER_HOST === 'string' && env.DOCKER_HOST.trim() ? env.DOCKER_HOST.trim() : 'unix:///var/run/docker.sock';
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  const url = new URL(value.replace(/^tcp:\/\//, 'http://'));
  return { host: url.hostname, port: Number(url.port) || 2375 };
}

export function dockerGet(path, { env = process.env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...dockerEndpoint(env), path, method: 'GET', headers: { host: 'docker' }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          let message = body.trim();
          try {
            message = JSON.parse(body).message || message;
          } catch {
            // corpo sem JSON
          }
          reject(new Error(`docker API ${path.split('?')[0]}: HTTP ${res.statusCode}${message ? `: ${message}` : ''}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// "0.0.0.0:8200->8000/tcp, 8080/tcp", como o `docker ps` escreve.
export function formatPorts(ports = []) {
  return [...ports]
    .sort((a, b) => (a.PrivatePort - b.PrivatePort) || String(a.IP ?? '').localeCompare(String(b.IP ?? '')))
    .map((port) => {
      const inner = `${port.PrivatePort}/${port.Type || 'tcp'}`;
      if (!port.PublicPort) return inner;
      const ip = port.IP && port.IP.includes(':') ? `[${port.IP}]` : port.IP || '0.0.0.0';
      return `${ip}:${port.PublicPort}->${inner}`;
    })
    .join(', ');
}

// Um item de GET /containers/json na forma que o resto do portal usa.
export function normalizeApiContainer(row = {}) {
  const labels = row.Labels && typeof row.Labels === 'object' ? row.Labels : {};
  return {
    id: row.Id ?? null,
    name: String(row.Names?.[0] ?? row.Id ?? '').replace(/^\//, ''),
    image: row.Image ?? null,
    state: row.State ?? null,
    status: row.Status ?? null,
    ports: formatPorts(row.Ports),
    labels,
    docker_stack: labels['com.docker.compose.project'] || null,
    docker_service: labels['com.docker.compose.service'] || null,
    size_writable_bytes: row.SizeRw ?? null,
    size_virtual_bytes: row.SizeRootFs ?? null,
  };
}

function shortBytes(value) {
  const bytes = Number(value) || 0;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  return `${index === 0 ? amount : amount.toFixed(amount >= 100 ? 0 : 1)}${units[index]}`;
}

// GET /containers/ID/stats?stream=0 na forma de `docker stats` (o mesmo calculo do CLI).
export function normalizeApiStats(name, stats = {}) {
  const cpu = stats.cpu_stats ?? {};
  const pre = stats.precpu_stats ?? {};
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const online = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  const mem = stats.memory_stats ?? {};
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  const used = mem.usage != null ? Math.max(0, mem.usage - cache) : null;
  const limit = mem.limit ?? null;
  const net = Object.values(stats.networks ?? {}).reduce((acc, n) => ({ rx: acc.rx + (n.rx_bytes ?? 0), tx: acc.tx + (n.tx_bytes ?? 0) }), { rx: 0, tx: 0 });
  const io = (stats.blkio_stats?.io_service_bytes_recursive ?? []).reduce((acc, entry) => {
    const op = String(entry.op).toLowerCase();
    if (op === 'read') acc.read += entry.value ?? 0;
    if (op === 'write') acc.write += entry.value ?? 0;
    return acc;
  }, { read: 0, write: 0 });
  return {
    id: stats.id ?? null,
    name,
    cpu_percent: systemDelta > 0 && cpuDelta > 0 ? Math.round((cpuDelta / systemDelta) * online * 10000) / 100 : 0,
    memory_usage_bytes: used,
    memory_limit_bytes: limit,
    memory_percent: used != null && limit ? Math.round((used / limit) * 10000) / 100 : null,
    net_io: `${shortBytes(net.rx)} / ${shortBytes(net.tx)}`,
    block_io: `${shortBytes(io.read)} / ${shortBytes(io.write)}`,
    pids: stats.pids_stats?.current ?? null,
  };
}
