import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync, existsSync } from 'node:fs';
import { atomicJson, readJson } from './ihapp-store.js';
import { archiveFiles, LIMITS, IhappError, runFile } from './ihapp-files.js';

export function createIhappLinks({ store, config, git }) {
  const keyFile = path.join(store.dir, 'link-key');
  try { writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = readFileSync(keyFile);
  const location = id => path.join(store.dir, 'links', `${id}.json`);
  const archive = id => path.join(store.dir, 'links', `${id}.tar.gz`);
  const mac = text => crypto.createHmac('sha256', key).update(text).digest('base64url');
  function issue(kind, person, extra = {}) {
    const id = `${kind === 'upload' ? 'up' : 'src'}_${crypto.randomBytes(12).toString('hex')}`;
    const expires = store.now() + (kind === 'upload' ? 900_000 : 300_000);
    const link = { id, kind, person, expires, used: false, ...extra };
    atomicJson(location(id), link);
    const payload = Buffer.from(JSON.stringify({ id, expires, kind })).toString('base64url');
    return { url: `${config.publicUrl}/ihapp/${kind}/${payload}.${mac(payload)}`, expires_at: new Date(expires).toISOString(), ...(kind === 'upload' ? { upload_id: id, max_bytes: LIMITS.upload_bytes } : {}) };
  }
  function verify(kind, token) {
    const [payload, signature, overflow] = String(token).split('.');
    if (overflow || !payload || !signature || signature.length !== mac(payload).length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mac(payload)))) return null;
    try {
      const signed = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!/^(?:up|src)_[a-f0-9]{24}$/.test(signed.id) || signed.kind !== kind || signed.expires <= store.now()) return null;
      const link = readJson(location(signed.id));
      return link?.expires === signed.expires && link.kind === kind ? link : null;
    } catch { return null; }
  }
  async function put(req, res) {
    const link = verify('upload', req.params.token);
    if (!link || link.used) return res.status(410).json({ error: 'upload_expired_or_used' });
    // Claim before the first await: two simultaneous PUTs cannot both win.
    atomicJson(location(link.id), { ...link, used: true, busy: true });
    let fd, size = 0;
    try {
      fd = openSync(archive(link.id), 'wx', 0o600);
      if (Number(req.headers['content-length']) > LIMITS.upload_bytes) throw new IhappError('IHC-FILES-LIMIT', 'Upload exceeds 25 MB.');
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMITS.upload_bytes) throw new IhappError('IHC-FILES-LIMIT', 'Upload exceeds 25 MB.');
        writeFileSync(fd, chunk);
      }
      closeSync(fd); fd = undefined;
      // Validate now, before accepting an upload ID as usable.
      await archiveFiles(archive(link.id));
      atomicJson(location(link.id), { ...link, used: true, ready: true });
      return res.status(201).json({ upload_id: link.id, bytes: size });
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      rmSync(archive(link.id), { force: true });
      atomicJson(location(link.id), { ...link, used: true });
      return res.status(error.code === 'IHC-FILES-LIMIT' ? 413 : 400).json({ error: error instanceof IhappError ? error.code : 'IHC-FILES-ARCHIVE', message: error instanceof IhappError ? error.message : 'The upload could not be read.' });
    }
  }
  async function consume(id, person) {
    const link = /^up_[0-9a-z]{8,40}$/.test(id) ? readJson(location(id)) : null;
    if (!link || link.person !== person || link.expires <= store.now() || !link.ready || !existsSync(archive(id))) throw new IhappError('IHC-FILES-ARCHIVE', 'Upload is unknown, expired, not ready, or belongs to another person.');
    return archiveFiles(archive(id));
  }
  async function get(req, res) {
    const link = verify('source', req.params.token);
    if (!link) return res.status(410).json({ error: 'source_expired' });
    const temp = store.temp();
    try {
      const files = await git.tree(link.slug, link.commit);
      const tree = path.join(temp, 'tree'); mkdirSync(tree);
      for (const [p, bytes] of files) { const file = path.join(tree, p); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes, { mode: 0o600 }); }
      const tar = path.join(temp, 'source.tar.gz');
      await runFile('tar', ['-czf', tar, '-C', tree, '.'], { timeout: 5000, env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' } });
      res.set('Cache-Control', 'no-store').type('application/gzip').attachment(`${link.slug}.tar.gz`).send(readFileSync(tar));
    } catch { res.status(503).json({ error: 'source_unavailable' }); }
    finally { rmSync(temp, { recursive: true, force: true }); }
  }
  return { issue, put, get, consume };
}
