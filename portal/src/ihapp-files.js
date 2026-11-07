import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const runFile = promisify(execFile);
export const LIMITS = { inline_bytes: 512 * 1024, file_bytes: 256 * 1024, files: 300, upload_bytes: 25 * 1024 * 1024, candidate_ttl_seconds: 86400, checks_per_hour: 30 };
export class IhappError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function validPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 300 && !/[\\\x00-\x1f\x7f]/.test(p) && !/^[A-Za-z]:/.test(p)
    && p.split('/').every(s => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}
export function checkPath(p) {
  if (!validPath(p)) throw new IhappError('IHC-FILES-PATH', 'A path is not a safe relative file path.');
  if (p.split('/').some(s => s === '.env' || (s.startsWith('.env.') && s !== '.env.example'))) throw new IhappError('IHC-FILES-ENV', 'Environment files are refused; use .env.example.');
}
export function checkTree(files, maxBytes = LIMITS.upload_bytes) {
  if (files.size > LIMITS.files) throw new IhappError('IHC-FILES-LIMIT', 'A tree may contain at most 300 files.');
  let bytes = 0;
  for (const [p, b] of files) {
    checkPath(p); bytes += b.length;
    if (b.length > LIMITS.file_bytes || bytes > maxBytes) throw new IhappError('IHC-FILES-LIMIT', 'The file or tree exceeds the advertised byte limit.');
    const parts = p.split('/');
    while (parts.pop() && parts.length) if (files.has(parts.join('/'))) throw new IhappError('IHC-FILES-PATH', 'A file also appears as a directory.');
  }
  return files;
}
export function inlineFiles(entries) {
  if (!Array.isArray(entries)) throw new IhappError('IHC-FILES-PATH', 'files must be a list.');
  const files = new Map(); let encodedBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.content !== 'string' || Object.keys(entry).some(k => !['path', 'content', 'encoding'].includes(k))) throw new IhappError('IHC-FILES-PATH', 'Each file needs path, content and optional encoding.');
    checkPath(entry.path);
    if (files.has(entry.path)) throw new IhappError('IHC-FILES-PATH', 'Duplicate file paths are refused.');
    if (!['utf8', 'base64'].includes(entry.encoding ?? 'utf8')) throw new IhappError('IHC-FILES-PATH', 'encoding must be utf8 or base64.');
    if (entry.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content))) throw new IhappError('IHC-FILES-PATH', 'Invalid base64 content.');
    encodedBytes += Buffer.byteLength(entry.content);
    if (encodedBytes > LIMITS.inline_bytes) throw new IhappError('IHC-FILES-LIMIT', 'Inline content exceeds 512 KB; use an upload link.');
    files.set(entry.path, Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  return checkTree(files, LIMITS.inline_bytes);
}
export function readTree(dir, prefix = '', files = new Map()) {
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) readTree(dir, p, files);
    else if (entry.isFile()) files.set(p, readFileSync(path.join(dir, p)));
    else throw new IhappError('IHC-FILES-PATH', 'Only regular files and directories are accepted.');
  }
  return files;
}
export async function archiveFiles(file) {
  try {
    // List first using the image's tar. Never ask tar to extract an untrusted archive.
    await runFile('tar', ['-tzvf', file], { timeout: 5000, maxBuffer: 512 * 1024 });
    const { stdout } = await runFile('python3', [fileURLToPath(new URL('./ihapp-archive.py', import.meta.url)), file], { timeout: 5000, maxBuffer: LIMITS.upload_bytes * 2 });
    const entries = JSON.parse(stdout);
    if (entries.error) throw new IhappError(entries.code, entries.error);
    return checkTree(new Map(entries.map(e => [e.path, Buffer.from(e.content, 'base64')])));
  } catch (error) {
    if (error instanceof IhappError) throw error;
    throw new IhappError('IHC-FILES-ARCHIVE', 'The archive is invalid, too large, or could not be listed within the time limit.');
  }
}
