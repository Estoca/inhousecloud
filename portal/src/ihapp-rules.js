// Shared by spec, check and deploy. Order matters: specific diagnostics precede fallback.
export const RULES = [
  ['IHC-FILES-PATH', 'manifest', 'Use unique relative paths with /, without dot segments, .git, backslashes or control characters.'],
  ['IHC-FILES-ENV', 'manifest', 'Remove .env and .env.*; only .env.example belongs in the tree.'],
  ['IHC-FILES-LIMIT', 'manifest', 'Reduce the tree to the advertised byte and file limits.'],
  ['IHC-FILES-ARCHIVE', 'manifest', 'Upload a valid tar.gz containing only regular files and directories.'],
  ['IHC-FILES-MODE', 'manifest', 'File modes come from content: a file that starts with #! is committed executable (100755); every other file is 100644. Start scripts that must run with a #! line.'],
  ['IHC-MANIFEST-INVALID', 'manifest', 'Correct company-app.yaml to the manifest contract.'],
  ['IHC-MANIFEST-SLUG', 'manifest', 'Use the requested, unreserved app slug in company-app.yaml.'],
  ['IHC-LINT-COMPOSE-INCLUDE', 'lint', 'Keep the compose configuration in this repository.', /include can import/],
  ['IHC-LINT-COMPOSE-EXTENDS', 'lint', 'Declare the service here instead of using extends.', /uses extends/],
  ['IHC-LINT-PRIVILEGES', 'lint', 'Remove added privileges, devices and capabilities.', /asks for (?:cap_add|devices|device_cgroup_rules)|privileged mode|privileged containers|setuid\/setgid/],
  ['IHC-LINT-HOST-NETWORK', 'lint', 'Remove host networking and namespace sharing.', /shares a host namespace|network_mode.*host|host network/],
  ['IHC-LINT-LIFECYCLE-HOOKS', 'lint', 'Keep host installation and scheduling in protected platform code.', /lifecycle deploy hooks|host cron|systemd|cron entry|host path or privileged host command/],
  ['IHC-LINT-PLATFORM-PATH', 'lint', 'Mount only the app data directory or app-owned volumes.', /mount overlaps paths managed/],
  ['IHC-LINT-HOST-MOUNT', 'lint', 'Use DATA_DIR or an app-owned named volume.', /host bind mount outside|docker\.sock|host bind mount/],
  ['IHC-LINT-EXTERNAL-VOLUME', 'lint', 'Remove external storage and platform resource adoption.', /driver_opts or external storage|adopts an external platform resource/],
  ['IHC-LINT-OWN-DATASTORE', 'lint', 'Use shared Postgres, Redis and object storage.', /own (?:Postgres|Redis|S3)|use the shared|declares a local service|shared is false/],
  ['IHC-LINT-BUILD-VARIABLE', 'lint', 'Use explicit build inputs inside this repository.', /unresolved build variable/],
  ['IHC-BUILD-CONTEXT', 'lint', 'Keep every build context and Dockerfile inside this repository.', /outside the repository|outside repository|must stay inside|build.*(?:escapes|remote)|Dockerfile.*(?:outside|leaves)/],
  ['IHC-LINT-OTHER', 'lint', 'Correct the reported trust-boundary violation.'],
  ['IHC-LINT-FAILED', 'lint', 'Ask an admin to restore the static linter, then check again.'],
  ['IHC-SECRETS-IN-TREE', 'secrets', 'Remove the credential and rotate it; use the platform credential proxy.'],
  ['IHC-CHECK-LIMIT', 'manifest', 'Wait for the current check or the hourly allowance to reset.'],
  ['IHC-BUILD-FAILED', 'build', 'Open the linked Actions run, fix the build and check a new candidate.'],
  ['IHC-HEALTH-STATUS', 'health', 'Fix the health path and sign-in protection, or restore the previous release.'],
  ['IHC-DEPLOY-STALE-BASE', 'commit', 'Read main again and check the changes against its new head.'],
  ['IHC-DEPLOY-CANDIDATE-EXPIRED', 'commit', 'Check this slug and base again and use its passed candidate within 24 hours.'],
  ['IHC-DEPLOY-NOT-ALLOWED', 'commit', 'Sign in to Gitea once and ask an admin to add you to the ihc-users team with push permission; new apps require the new-app group.'],
  ['IHC-DEPLOY-FAILED', 'commit', 'Ask an admin to check the deploy account and Gitea availability, then inspect main before retrying.'],
];

const SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gitea_[A-Za-z0-9]{20,})\b/g,
  /\b(?:Bearer|token)\s+[A-Za-z0-9_.-]{20,}/gi,
];
const ASSIGNMENT = /\b(?:[\w-]*(?:password|secret|token|api[_-]?key)[\w-]*)["']?\s*[:=]\s*(?:"(?<double>[^"\r\n]{16,})"|'(?<single>[^'\r\n]{16,})'|(?<bare>[^\s"'`,;{}]{16,}))/gi;
export function secretMatches(text, { example = false } = {}) {
  const found = [];
  for (const re of [...SHAPES, ...(example ? [] : [ASSIGNMENT])]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const literal = match.groups && (match.groups.double ?? match.groups.single ?? match.groups.bare);
      const value = literal ?? match[0];
      // An expression is not a literal credential (common in starter SDK examples).
      if (literal && (/^(?:process\.env\.|os\.environ|env\.|getenv\b)/.test(value) || /\$\{|\{\{|\$[A-Z_]/.test(value))) continue;
      if (/^(?:example|placeholder|changeme|your[_-]|replace[_-])/i.test(value)) continue;
      found.push({ value, index: match.index + match[0].indexOf(value) });
    }
  }
  return found;
}
export function redactText(text, values = []) {
  let out = String(text);
  for (const value of [...new Set([...values, ...secretMatches(out).map(m => m.value)])].sort((a, b) => b.length - a.length)) {
    if (value) out = out.split(value).join('[redacted]');
  }
  return out;
}
export function finding(code, message, extra = {}, values = []) {
  const rule = RULES.find(r => r[0] === code);
  const safeExtra = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, typeof v === 'string' ? redactText(v, values) : v]));
  return { code, stage: rule[1], severity: 'error', message: redactText(message, values).slice(0, 500) || code, fix: rule[2], ...safeExtra };
}
export function bounded(findings) {
  return { findings: findings.filter(f => f.severity === 'error').concat(findings.filter(f => f.severity !== 'error')).slice(0, 50), findings_truncated: findings.length > 50 };
}
export const STATIC_STAGES = ['manifest', 'lint', 'secrets'];
export const SKIPPED_REASON = 'runs in the deploy job in v1; the isolated check comes with LAB-170';
export const SKIPPED_STAGES = ['build', 'start', 'migrate', 'health', 'auth'].map(stage => ({ stage, state: 'skipped', reason: SKIPPED_REASON }));
