import path from 'node:path';
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { checkPath, checkTree, IhappError } from './ihapp-files.js';

// No checkout, hooks, filters, credential helpers or candidate executables. All object
// creation uses plumbing; the only concurrency primitive is a non-force git push.
export function gitEnvironment(config) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.extraheader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`${config.gitUser}:${config.token}`).toString('base64')}`,
    GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/dev/null',
    GIT_CONFIG_KEY_3: 'http.followRedirects', GIT_CONFIG_VALUE_3: 'false',
    GIT_AUTHOR_NAME: config.gitUser, GIT_COMMITTER_NAME: config.gitUser,
    GIT_AUTHOR_EMAIL: `${config.gitUser}@${config.baseDomain}`, GIT_COMMITTER_EMAIL: `${config.gitUser}@${config.baseDomain}` };
}
// The tree carries contents only, so the mode is derived from them, deterministically: a file
// that starts with "#!" is a script and stays executable (entrypoints keep working after a chat
// deploy); everything else is a regular file. ihapp_spec states this rule.
export function fileMode(data) {
  return data.length >= 2 && data[0] === 0x23 && data[1] === 0x21 ? '100755' : '100644';
}
export function git(args, { cwd, env, input, maxBytes = 30 * 1024 * 1024, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = [], stderr = [], bytes = 0, killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    const collect = target => chunk => { bytes += chunk.length; if (bytes > maxBytes) { killed = true; child.kill('SIGKILL'); } else target.push(chunk); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !killed) resolve(Buffer.concat(stdout));
      else reject(Object.assign(new Error('git operation failed'), { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), killed }));
    });
    child.stdin.end(input);
  });
}
export function createIhappGit({ config, store, remoteUrl = slug => `${config.giteaUrl}/${config.org}/${slug}.git` }) {
  const env = gitEnvironment(config);
  const remote = slug => {
    const url = remoteUrl(slug);
    if (/^https?:/.test(url) && (new URL(url).username || new URL(url).password)) throw new Error('git URL must not contain credentials');
    return url;
  };
  async function withRepo(fn) {
    const cwd = store.temp();
    try { await git(['init', '--bare', '--quiet', cwd], { env }); return await fn((args, options = {}) => git(args, { cwd, env, ...options }), cwd); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  async function head(slug) {
    const out = await git(['ls-remote', remote(slug), 'refs/heads/main'], { env });
    return out.toString().trim().split(/\s/)[0] || null;
  }
  async function tree(slug, commit) {
    return withRepo(async exec => {
      await exec(['fetch', '--quiet', '--depth=1', remote(slug), commit]);
      const list = (await exec(['ls-tree', '-rz', commit])).toString().split('\0').filter(Boolean);
      const files = new Map();
      if (list.length > 300) throw new IhappError('IHC-FILES-LIMIT', 'The base tree contains more than 300 files.');
      for (const item of list) {
        const match = item.match(/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/);
        if (!match || !['100644', '100755'].includes(match[1])) throw new IhappError('IHC-FILES-PATH', 'The base tree contains a symlink or submodule.');
        checkPath(match[3]);
        const size = Number((await exec(['cat-file', '-s', match[2]])).toString());
        if (size > 256 * 1024) throw new IhappError('IHC-FILES-LIMIT', 'A base file exceeds 256 KB.');
        files.set(match[3], await exec(['cat-file', 'blob', match[2]]));
      }
      return checkTree(files);
    });
  }
  async function push(slug, base, files, message) {
    return withRepo(async (exec, cwd) => {
      if (base) await exec(['fetch', '--quiet', '--depth=1', remote(slug), base]);
      const records = [];
      for (const [p, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        const oid = (await exec(['hash-object', '-w', '--stdin', '--no-filters'], { input: data })).toString().trim();
        records.push(Buffer.from(`${fileMode(data)} ${oid}\t${p}\0`));
      }
      await exec(['update-index', '-z', '--index-info'], { input: Buffer.concat(records), env: { ...env, GIT_INDEX_FILE: path.join(cwd, 'candidate-index') } });
      const tree = (await exec(['write-tree'], { env: { ...env, GIT_INDEX_FILE: path.join(cwd, 'candidate-index') } })).toString().trim();
      const commit = (await exec(['commit-tree', tree, ...(base ? ['-p', base] : [])], { input: message })).toString().trim();
      // Create HEAD only in this temporary object database. Never force the remote.
      await exec(['update-ref', 'refs/heads/main', commit]);
      await exec(['symbolic-ref', 'HEAD', 'refs/heads/main']);
      try { await exec(['push', '--porcelain', remote(slug), 'HEAD:main']); }
      catch (error) {
        if (/\[rejected\]|non-fast-forward|fetch first/.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) throw new IhappError('IHC-DEPLOY-STALE-BASE', 'main moved since the candidate was checked; nothing was overwritten.');
        throw new IhappError('IHC-DEPLOY-FAILED', 'The git push failed; inspect main before retrying.');
      }
      return commit;
    });
  }
  return { tree, head, push };
}
