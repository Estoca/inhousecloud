// Fixed destinations: neither manifests nor callers can choose a host.
export const SERVICES = Object.freeze({
  slack: 'https://slack.com/api',
  github: 'https://api.github.com',
  linear: 'https://api.linear.app',
  hubspot: 'https://api.hubapi.com',
});
export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// No escapes, dot segments, double slashes or backslashes: both sides must
// interpret exactly the same path. Query strings are excluded from policy/audit.
export function safePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !/[^A-Za-z0-9/_~.-]/.test(path)
    && !path.includes('//') && !path.split('/').some((part) => part === '.' || part === '..');
}
export function policyErrors(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['secrets_proxy must be a service map'];
  const errors = [];
  for (const [service, rule] of Object.entries(policy)) {
    if (!Object.hasOwn(SERVICES, service)) {
      errors.push('secrets_proxy: unknown service');
      continue;
    }
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some((key) => !['methods', 'path_prefixes'].includes(key))
        || !Array.isArray(rule.path_prefixes) || !rule.path_prefixes.length || !rule.path_prefixes.every(safePath)
        || !Array.isArray(rule.methods) || !rule.methods.length
        || !rule.methods.every((method) => METHODS.includes(method))) errors.push('secrets_proxy: services need explicit methods and canonical path_prefixes');
  }
  return errors;
}
export function allowedPrefix(policy, service, method, path) {
  if (policyErrors(policy).length || !safePath(path)) return null;
  const rule = policy[service];
  if (!rule?.methods.includes(method)) return null;
  return rule.path_prefixes.find((prefix) => prefix === '/' || path === prefix
    || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) ?? null;
}
