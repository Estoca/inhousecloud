import { IhappError } from './ihapp-files.js';

const slug = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' };
const commit = { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{40}$' }, { type: 'null' }] };
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const list = items => ({ type: 'array', items });
export const INPUTS = {
  ihapp_spec: object({ slug, include: { ...list({ enum: ['template', 'source', 'upload'] }), uniqueItems: true }, start_from: { type: 'string' } }),
  ihapp_check: object({ slug, base_commit: commit, tree: { enum: ['full', 'changes'] }, files: list(object({ path: { type: 'string' }, content: { type: 'string' }, encoding: { enum: ['utf8', 'base64'] } }, ['path', 'content'])), delete: list({ type: 'string' }), upload_id: { type: 'string', pattern: '^up_[0-9a-z]{8,40}$' } }, ['slug', 'base_commit', 'tree']),
  ihapp_deploy: object({ slug, candidate_id: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, base_commit: commit, message: { type: 'string', minLength: 3, maxLength: 200, pattern: '^[^\\r\\n\\u0000]+$' }, confirmed_by: { type: 'string', minLength: 1, maxLength: 254 } }, ['slug', 'candidate_id', 'base_commit', 'message', 'confirmed_by']),
  ihapp_deploy_status: { ...object({ job_id: { type: 'string', pattern: '^job_[0-9a-z]{8,40}$' }, slug }), oneOf: [{ required: ['job_id'] }, { required: ['slug'] }] },
};

// Deliberately small validator for these four closed input objects. Byte limits and
// path restrictions are applied while materializing, so they produce refused jobs.
export function matches(schema, value) {
  if (schema.anyOf && !schema.anyOf.some(s => matches(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => matches(s, value)).length !== 1) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.required && (!value || schema.required.some(k => !Object.hasOwn(value, k)))) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string' && (!schema.pattern || new RegExp(schema.pattern).test(value)) && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
  if (schema.type === 'array') return Array.isArray(value) && (!schema.uniqueItems || new Set(value).size === value.length) && value.every(v => matches(schema.items, v));
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => Object.hasOwn(schema.properties, k) ? matches(schema.properties[k], value[k]) : schema.additionalProperties !== false);
  return true;
}
export function validateInput(name, input) {
  if (!matches(INPUTS[name], input)) throw new IhappError('IHC-MANIFEST-INVALID', `Invalid input for ${name}; follow its inputSchema.`);
  if (name === 'ihapp_spec' && input.start_from !== undefined) throw new IhappError('IHC-MANIFEST-INVALID', 'start_from is reserved for the app catalog.');
  if (name === 'ihapp_check' && ((Object.hasOwn(input, 'files') === Object.hasOwn(input, 'upload_id')) || (input.tree === 'changes' && input.base_commit === null) || (input.tree === 'full' && input.delete !== undefined))) throw new IhappError('IHC-MANIFEST-INVALID', 'Provide files or upload_id; changes require a base commit; delete requires changes.');
}
